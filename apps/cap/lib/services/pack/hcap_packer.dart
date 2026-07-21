import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../data/models.dart';

/// Builds a compressed `.hcap` ZIP (office profile: selected frames + meta).
class HcapPacker {
  Future<File> pack({
    required Job job,
    required String projectName,
    required List<File> frameFiles,
    required List<PoseLine> poses,
    List<GnssSample> trajectory = const [],
    String appVersion = '0.1.0',
  }) async {
    final dir = await getTemporaryDirectory();
    final outPath = p.join(
      dir.path,
      '${_safe(job.name)}.hcap',
    );

    final archive = Archive();
    final checksums = StringBuffer();

    void addFile(String name, List<int> bytes) {
      archive.addFile(ArchiveFile(name, bytes.length, bytes));
      final digest = sha256.convert(bytes);
      checksums.writeln('$digest  $name');
    }

    final framesMeta = <Map<String, dynamic>>[];
    for (var i = 0; i < frameFiles.length; i++) {
      final f = frameFiles[i];
      final bytes = await f.readAsBytes();
      final rel = 'media/frames/${(i + 1).toString().padLeft(6, '0')}.jpg';
      addFile(rel, bytes);
      framesMeta.add({
        'index': i,
        'path': rel,
        'sha256': sha256.convert(bytes).toString(),
        'capturedAt': poses.length > i
            ? poses[i].timestampUtc.toUtc().toIso8601String()
            : job.createdAt.toUtc().toIso8601String(),
      });
    }

    final posesBody = poses.map((e) => e.toJsonLine()).join('\n');
    if (posesBody.isNotEmpty) {
      addFile('poses.jsonl', utf8.encode('$posesBody\n'));
    }

    if (trajectory.isNotEmpty) {
      final lines = trajectory.map((s) {
        return jsonEncode({
          't': s.timestamp.toUtc().toIso8601String(),
          'lat': s.latitude,
          'lon': s.longitude,
          'h': s.altitude,
          'sigmaH': s.sigmaH,
          'sigmaV': s.sigmaV,
          'fix': s.fixType.name,
        });
      }).join('\n');
      addFile('trajectory.jsonl', utf8.encode('$lines\n'));
    }

    final manifest = {
      'format': 'himmelcap-session',
      'schemaVersion': 1,
      'packageProfile': 'office',
      'sessionId': job.id,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
      'app': {'name': 'HimmelCAD Cap', 'version': appVersion},
      'device': {
        'platform': Platform.isIOS ? 'ios' : 'android',
        'model': Platform.operatingSystemVersion,
      },
      'capture': {
        'mode': 'smartstills',
        'preview': 'video',
        'frameCount': frameFiles.length,
        'stillTrigger': 'time',
      },
      'positioning': {
        'bestTier': job.quality,
      },
      'media': {'frames': framesMeta, 'video': null},
      'qualitySummary': {
        'meanHorizontalSigmaM': job.sigmaH,
        'meanVerticalSigmaV': job.sigmaV,
        'fixFraction': job.fixPct / 100.0,
        'floatFraction': job.floatPct / 100.0,
      },
      'export': {
        'suggestedFileName': '${_safe(job.name)}.hcap',
        'projectName': projectName,
      },
    };
    addFile(
      'manifest.json',
      utf8.encode(const JsonEncoder.withIndent('  ').convert(manifest)),
    );
    addFile('checksums.sha256', utf8.encode(checksums.toString()));

    final zipped = ZipEncoder().encode(archive);
    if (zipped == null) {
      throw StateError('zip encode failed');
    }
    final out = File(outPath);
    await out.writeAsBytes(Uint8List.fromList(zipped), flush: true);

    // Persist under documents for drafts/share
    final docs = await getApplicationDocumentsDirectory();
    final permanent = File(p.join(docs.path, 'jobs', '${job.id}.hcap'));
    await permanent.parent.create(recursive: true);
    await out.copy(permanent.path);
    return permanent;
  }

  String _safe(String name) =>
      name.replaceAll(RegExp(r'[^\w\-]+'), '_').replaceAll(RegExp(r'_+'), '_');
}
