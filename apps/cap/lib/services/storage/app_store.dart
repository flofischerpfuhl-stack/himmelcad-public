import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/models.dart';

class AppStore extends ChangeNotifier {
  AppStore();

  static const _kProjects = 'hcap.projects';
  static const _kActiveProject = 'hcap.activeProject';
  static const _kRtk = 'hcap.rtkProfiles';
  static const _kTheme = 'hcap.theme';
  static const _kLocale = 'hcap.locale';
  static const _kAutoUpload = 'hcap.autoUpload';
  static const _kStillIntervalMs = 'hcap.stillIntervalMs';

  final List<Project> projects = [];
  String? activeProjectId;
  final List<RtkProfile> rtkProfiles = [];
  String themeMode = 'dark';
  String localeCode = 'de';
  bool autoUpload = false;
  int stillIntervalMs = 1500;

  Project get activeProject {
    if (projects.isEmpty) {
      throw StateError('no projects');
    }
    return projects.firstWhere(
      (p) => p.id == activeProjectId,
      orElse: () => projects.first,
    );
  }

  RtkProfile? get activeRtk {
    for (final p in rtkProfiles) {
      if (p.active) return p;
    }
    return rtkProfiles.isEmpty ? null : rtkProfiles.first;
  }

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    themeMode = prefs.getString(_kTheme) ?? 'dark';
    localeCode = prefs.getString(_kLocale) ?? 'de';
    autoUpload = prefs.getBool(_kAutoUpload) ?? false;
    stillIntervalMs = prefs.getInt(_kStillIntervalMs) ?? 1500;

    projects.clear();
    final raw = prefs.getString(_kProjects);
    if (raw != null && raw.isNotEmpty) {
      final list = jsonDecode(raw) as List;
      projects.addAll(
        list.map((e) => Project.fromJson(e as Map<String, dynamic>)),
      );
    }
    if (projects.isEmpty) {
      projects.addAll(_seed());
    }
    activeProjectId = prefs.getString(_kActiveProject);
    if (activeProjectId == null ||
        !projects.any((p) => p.id == activeProjectId)) {
      activeProjectId = projects.first.id;
    }

    rtkProfiles.clear();
    final rtkRaw = prefs.getString(_kRtk);
    if (rtkRaw != null && rtkRaw.isNotEmpty) {
      final list = jsonDecode(rtkRaw) as List;
      rtkProfiles.addAll(
        list.map((e) => RtkProfile.fromJson(e as Map<String, dynamic>)),
      );
    }
    if (rtkProfiles.isEmpty) {
      rtkProfiles.add(
        RtkProfile(
          id: newId(),
          name: 'SAPOS HEPS',
          host: '',
          mountpoint: '',
          active: true,
        ),
      );
    }
    notifyListeners();
  }

  Future<void> persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _kProjects,
      jsonEncode(projects.map((p) => p.toJson()).toList()),
    );
    await prefs.setString(_kActiveProject, activeProjectId ?? '');
    await prefs.setString(
      _kRtk,
      jsonEncode(rtkProfiles.map((p) => p.toJson()).toList()),
    );
    await prefs.setString(_kTheme, themeMode);
    await prefs.setString(_kLocale, localeCode);
    await prefs.setBool(_kAutoUpload, autoUpload);
    await prefs.setInt(_kStillIntervalMs, stillIntervalMs);
  }

  Future<void> setActiveProject(String id) async {
    activeProjectId = id;
    await persist();
    notifyListeners();
  }

  Future<void> addProject(String name) async {
    final p = Project(id: newId(), name: name);
    projects.add(p);
    activeProjectId = p.id;
    await persist();
    notifyListeners();
  }

  Future<void> upsertJob(Job job) async {
    final p = projects.firstWhere((e) => e.id == job.projectId);
    final i = p.jobs.indexWhere((j) => j.id == job.id);
    if (i >= 0) {
      p.jobs[i] = job;
    } else {
      p.jobs.insert(0, job);
    }
    await persist();
    notifyListeners();
  }

  Future<void> appendNote(String jobId, String text) async {
    for (final p in projects) {
      for (final j in p.jobs) {
        if (j.id == jobId) {
          j.notes.add(text);
          await persist();
          notifyListeners();
          return;
        }
      }
    }
  }

  Future<void> setThemeMode(String mode) async {
    themeMode = mode;
    await persist();
    notifyListeners();
  }

  Future<void> setLocaleCode(String code) async {
    localeCode = code;
    await persist();
    notifyListeners();
  }

  Future<void> setAutoUpload(bool v) async {
    autoUpload = v;
    await persist();
    notifyListeners();
  }

  Future<void> setActiveRtk(String id) async {
    for (final p in rtkProfiles) {
      p.active = p.id == id;
    }
    await persist();
    notifyListeners();
  }

  Future<void> addRtkProfile(RtkProfile profile) async {
    for (final p in rtkProfiles) {
      p.active = false;
    }
    profile.active = true;
    rtkProfiles.add(profile);
    await persist();
    notifyListeners();
  }

  List<Project> _seed() {
    final pid = newId();
    final jid = newId();
    return [
      Project(
        id: pid,
        name: 'MUC FTTH Nord',
        jobs: [
          Job(
            id: jid,
            projectId: pid,
            name: 'Graben Nord — FTTH',
            createdAt: DateTime.now().subtract(const Duration(days: 3)),
            description: 'Offener Graben, PE 110, ca. 0,8 m.',
            quality: 'float',
            sigmaH: 0.38,
            sigmaV: 0.72,
            fixPct: 8,
            floatPct: 79,
            path: [
              const LatLng(48.1372, 11.575),
              const LatLng(48.1375, 11.5758),
              const LatLng(48.1379, 11.5764),
              const LatLng(48.1382, 11.5771),
            ],
          ),
        ],
      ),
      Project(
        id: newId(),
        name: 'Trasse Ost',
        jobs: [],
      ),
    ];
  }
}
