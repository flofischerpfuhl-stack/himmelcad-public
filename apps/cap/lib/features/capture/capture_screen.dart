import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';

import '../../data/models.dart';
import '../../l10n/app_localizations.dart';
import '../../services/gnss/gnss_engine.dart';
import '../../services/pack/hcap_packer.dart';
import '../../services/storage/app_store.dart';
import '../../theme/hc_theme.dart';
import '../../widgets/hc_island.dart';

class CaptureScreen extends StatefulWidget {
  const CaptureScreen({
    super.key,
    required this.onBack,
    required this.onJobSaved,
  });

  final VoidCallback onBack;
  final void Function(Job job) onJobSaved;

  @override
  State<CaptureScreen> createState() => _CaptureScreenState();
}

class _CaptureScreenState extends State<CaptureScreen> {
  CameraController? _camera;
  bool _recording = false;
  int _seconds = 0;
  int _frames = 0;
  Timer? _tick;
  Timer? _stillTimer;
  final _frameFiles = <File>[];
  final _poses = <PoseLine>[];
  final _track = <GnssSample>[];
  bool _saving = false;
  bool _packReady = false;
  String? _hcapPath;
  final _nameCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  double _progress = 0;

  @override
  void initState() {
    super.initState();
    _initCamera();
  }

  Future<void> _initCamera() async {
    try {
      final cams = await availableCameras();
      if (cams.isEmpty) return;
      final cam = cams.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.back,
        orElse: () => cams.first,
      );
      final ctrl = CameraController(
        cam,
        ResolutionPreset.high,
        enableAudio: false,
        imageFormatGroup: ImageFormatGroup.jpeg,
      );
      await ctrl.initialize();
      // Best-effort photogrammetry defaults.
      try {
        await ctrl.setFocusMode(FocusMode.locked);
      } catch (_) {}
      try {
        await ctrl.setExposureMode(ExposureMode.locked);
      } catch (_) {}
      if (!mounted) return;
      setState(() => _camera = ctrl);
    } catch (e) {
      debugPrint('camera init: $e');
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    _stillTimer?.cancel();
    _camera?.dispose();
    _nameCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  void _start() {
    final store = context.read<AppStore>();
    setState(() {
      _recording = true;
      _seconds = 0;
      _frames = 0;
      _frameFiles.clear();
      _poses.clear();
      _track.clear();
    });
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _seconds++);
      final g = context.read<GnssEngine>().lastSample;
      if (g != null) _track.add(g);
    });
    _stillTimer = Timer.periodic(
      Duration(milliseconds: store.stillIntervalMs),
      (_) => _captureStill(),
    );
  }

  Future<void> _captureStill() async {
    final cam = _camera;
    if (cam == null || !cam.value.isInitialized || !_recording) return;
    final g = mounted ? context.read<GnssEngine>().lastSample : null;
    try {
      final shot = await cam.takePicture();
      final dir = await getTemporaryDirectory();
      final dest = File(
        p.join(dir.path, 'frames', '${DateTime.now().millisecondsSinceEpoch}.jpg'),
      );
      await dest.parent.create(recursive: true);
      await File(shot.path).copy(dest.path);
      if (!mounted) return;
      final idx = _frameFiles.length;
      _frameFiles.add(dest);
      final sh = g?.sigmaH ?? 5.0;
      final sv = g?.sigmaV ?? 10.0;
      _poses.add(
        PoseLine(
          frameIndex: idx,
          latitude: g?.latitude ?? 0,
          longitude: g?.longitude ?? 0,
          heightMeters: g?.altitude ?? 0,
          covarianceEnuM2: [sh * sh, 0, 0, 0, sh * sh, 0, 0, 0, sv * sv],
          fixType: g?.fixType.name ?? 'unknown',
          tier: g?.tier.name ?? 'unknown',
          timestampUtc: DateTime.now().toUtc(),
        ),
      );
      setState(() => _frames = _frameFiles.length);
    } catch (e) {
      debugPrint('still: $e');
    }
  }

  Future<void> _stop() async {
    _tick?.cancel();
    _stillTimer?.cancel();
    setState(() {
      _recording = false;
      _saving = true;
      _packReady = false;
      _progress = 0;
    });
    final store = context.read<AppStore>();
    final project = store.activeProject;
    final now = DateTime.now();
    final pref =
        '${now.day.toString().padLeft(2, '0')}.${now.month.toString().padLeft(2, '0')}.${now.year} '
        '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')} · ${project.name}';
    _nameCtrl.text = pref;
    _descCtrl.text = '';

    // Background pack
    unawaited(_packInBackground());
  }

  Future<void> _packInBackground() async {
    if (!mounted) return;
    final store = context.read<AppStore>();
    final g = context.read<GnssEngine>().lastSample;
    final projectName = store.activeProject.name;
    final projectId = store.activeProject.id;
    final frames = List<File>.of(_frameFiles);
    final poses = List<PoseLine>.of(_poses);
    final track = List<GnssSample>.of(_track);
    try {
      for (var i = 1; i <= 8; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 120));
        if (mounted) setState(() => _progress = i / 10);
      }
      final job = Job(
        id: newId(),
        projectId: projectId,
        name: _nameCtrl.text,
        createdAt: DateTime.now(),
        description: _descCtrl.text.trim(),
        status: JobStatus.packing,
        quality: g?.fixType.name ?? 'single',
        sigmaH: g?.sigmaH ?? 5,
        sigmaV: g?.sigmaV ?? 10,
        path: track.map((e) => e.latLng).toList(),
        frameCount: frames.length,
      );
      final file = await HcapPacker().pack(
        job: job,
        projectName: projectName,
        frameFiles: frames,
        poses: poses,
        trajectory: track,
      );
      if (!mounted) return;
      setState(() {
        _hcapPath = file.path;
        _packReady = true;
        _progress = 1;
      });
    } catch (e) {
      debugPrint('pack: $e');
      if (mounted) {
        setState(() {
          _packReady = true;
          _progress = 1;
        });
      }
    }
  }

  Future<void> _save({required bool asDraft}) async {
    final store = context.read<AppStore>();
    final g = context.read<GnssEngine>().lastSample;
    final job = Job(
      id: newId(),
      projectId: store.activeProject.id,
      name: _nameCtrl.text.trim().isEmpty ? 'Job' : _nameCtrl.text.trim(),
      createdAt: DateTime.now(),
      description: _descCtrl.text.trim(),
      status: asDraft ? JobStatus.draft : JobStatus.ready,
      quality: g?.fixType.name ?? 'single',
      sigmaH: g?.sigmaH ?? 5,
      sigmaV: g?.sigmaV ?? 10,
      path: _track.map((e) => e.latLng).toList(),
      hcapPath: _hcapPath,
      frameCount: _frameFiles.length,
      fixPct: g?.fixType == GnssFixType.fix ? 50 : 0,
      floatPct: g?.fixType == GnssFixType.float ? 80 : 20,
    );
    await store.upsertJob(job);
    if (!mounted) return;
    widget.onJobSaved(job);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final gnss = context.watch<GnssEngine>();
    final sample = gnss.lastSample;
    final fix = sample?.fixType ?? GnssFixType.none;
    final color = switch (fix) {
      GnssFixType.fix => HcTokens.success,
      GnssFixType.float => HcTokens.warning,
      GnssFixType.single => HcTokens.warning,
      GnssFixType.none => HcTokens.error,
    };
    final label = switch (fix) {
      GnssFixType.fix => l10n.gnssFix,
      GnssFixType.float => l10n.gnssFloat,
      GnssFixType.single => l10n.gnssPhoneOnly,
      GnssFixType.none => l10n.gnssNoCorrection,
    };

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          if (_camera != null && _camera!.value.isInitialized)
            CameraPreview(_camera!)
          else
            Container(color: const Color(0xFF1E2A22)),
          Positioned(
            top: MediaQuery.paddingOf(context).top + 8,
            left: 12,
            child: HcIsland(
              padding: EdgeInsets.zero,
              child: IconButton(
                onPressed: () {
                  if (_saving) {
                    _save(asDraft: true);
                  } else {
                    widget.onBack();
                  }
                },
                icon: const Icon(Icons.chevron_left),
              ),
            ),
          ),
          Positioned(
            top: MediaQuery.paddingOf(context).top + 8,
            left: 64,
            right: 12,
            child: HcIsland(
              child: Row(
                children: [
                  Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
                        Text(
                          l10n.sigmaLine(
                            (sample?.sigmaH ?? 5).toStringAsFixed(2),
                            (sample?.sigmaV ?? 10).toStringAsFixed(2),
                          ),
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              padding: EdgeInsets.fromLTRB(20, 24, 20, MediaQuery.paddingOf(context).bottom + 24),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Colors.transparent, Colors.black54],
                ),
              ),
              child: Column(
                children: [
                  if (_recording)
                    Text(
                      '● ${l10n.rec}  ${_fmt(_seconds)}  ·  ${l10n.frames(_frames)}',
                      style: const TextStyle(color: Colors.white, fontFamily: 'monospace'),
                    ),
                  const SizedBox(height: 12),
                  GestureDetector(
                    onTap: () {
                      if (_saving) return;
                      if (_recording) {
                        _stop();
                      } else {
                        _start();
                      }
                    },
                    child: Container(
                      width: 80,
                      height: 80,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 4),
                      ),
                      alignment: Alignment.center,
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 160),
                        width: _recording ? 28 : 62,
                        height: _recording ? 28 : 62,
                        decoration: BoxDecoration(
                          color: HcTokens.error,
                          borderRadius: BorderRadius.circular(_recording ? 6 : 31),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_saving)
            Container(
              color: Colors.black54,
              alignment: Alignment.center,
              child: HcIsland(
                padding: const EdgeInsets.all(20),
                child: SizedBox(
                  width: 300,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        l10n.saveJob,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _nameCtrl,
                        decoration: InputDecoration(labelText: l10n.name),
                      ),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _descCtrl,
                        maxLines: 3,
                        decoration: InputDecoration(labelText: l10n.descriptionOptional),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _packReady ? l10n.packageReady : l10n.packing,
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                      const SizedBox(height: 6),
                      LinearProgressIndicator(value: _progress == 0 ? null : _progress),
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: _packReady ? () => _save(asDraft: false) : null,
                        child: Text(l10n.save),
                      ),
                      TextButton(
                        onPressed: () => _save(asDraft: true),
                        child: Text('${l10n.cancel} → ${l10n.draft}'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  String _fmt(int s) {
    final m = (s ~/ 60).toString().padLeft(2, '0');
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$m:$ss';
  }
}
