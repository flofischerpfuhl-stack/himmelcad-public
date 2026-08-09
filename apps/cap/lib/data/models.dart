import 'dart:convert';

import 'package:latlong2/latlong.dart';
import 'package:uuid/uuid.dart';

enum JobStatus { ready, draft, packing }

enum GnssFixType { none, single, float, fix }

enum GnssTier {
  t0Consumer,
  t1DualFrequency,
  t2NtripFloat,
  t2NtripFix,
  unknown,
}

class Project {
  Project({
    required this.id,
    required this.name,
    List<Job>? jobs,
  }) : jobs = jobs ?? [];

  final String id;
  String name;
  final List<Job> jobs;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'jobs': jobs.map((j) => j.toJson()).toList(),
      };

  factory Project.fromJson(Map<String, dynamic> j) => Project(
        id: j['id'] as String,
        name: j['name'] as String,
        jobs: (j['jobs'] as List? ?? [])
            .map((e) => Job.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class Job {
  Job({
    required this.id,
    required this.projectId,
    required this.name,
    required this.createdAt,
    this.description = '',
    List<String>? notes,
    this.status = JobStatus.ready,
    this.quality = 'float',
    this.sigmaH = 1.0,
    this.sigmaV = 2.0,
    this.fixPct = 0,
    this.floatPct = 0,
    List<LatLng>? path,
    this.hcapPath,
    this.frameCount = 0,
  })  : notes = notes ?? (description.isEmpty ? <String>[] : [description]),
        path = path ?? [];

  final String id;
  final String projectId;
  String name;
  final DateTime createdAt;
  String description;
  final List<String> notes;
  JobStatus status;
  String quality;
  double sigmaH;
  double sigmaV;
  int fixPct;
  int floatPct;
  final List<LatLng> path;
  String? hcapPath;
  int frameCount;

  bool get showOnMap => status == JobStatus.ready;

  Map<String, dynamic> toJson() => {
        'id': id,
        'projectId': projectId,
        'name': name,
        'createdAt': createdAt.toIso8601String(),
        'description': description,
        'notes': notes,
        'status': status.name,
        'quality': quality,
        'sigmaH': sigmaH,
        'sigmaV': sigmaV,
        'fixPct': fixPct,
        'floatPct': floatPct,
        'path': path.map((p) => [p.latitude, p.longitude]).toList(),
        'hcapPath': hcapPath,
        'frameCount': frameCount,
      };

  factory Job.fromJson(Map<String, dynamic> j) => Job(
        id: j['id'] as String,
        projectId: j['projectId'] as String,
        name: j['name'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String),
        description: j['description'] as String? ?? '',
        notes: (j['notes'] as List? ?? []).cast<String>(),
        status: JobStatus.values.firstWhere(
          (e) => e.name == j['status'],
          orElse: () => JobStatus.ready,
        ),
        quality: j['quality'] as String? ?? 'float',
        sigmaH: (j['sigmaH'] as num?)?.toDouble() ?? 1,
        sigmaV: (j['sigmaV'] as num?)?.toDouble() ?? 2,
        fixPct: j['fixPct'] as int? ?? 0,
        floatPct: j['floatPct'] as int? ?? 0,
        path: (j['path'] as List? ?? [])
            .map((e) => LatLng((e[0] as num).toDouble(), (e[1] as num).toDouble()))
            .toList(),
        hcapPath: j['hcapPath'] as String?,
        frameCount: j['frameCount'] as int? ?? 0,
      );
}

class RtkProfile {
  RtkProfile({
    required this.id,
    required this.name,
    required this.host,
    this.port = 2101,
    required this.mountpoint,
    this.username = '',
    this.active = false,
  });

  final String id;
  String name;
  String host;
  int port;
  String mountpoint;
  String username;
  bool active;

  String get detail => '$host · $mountpoint';

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'host': host,
        'port': port,
        'mountpoint': mountpoint,
        'username': username,
        'active': active,
      };

  factory RtkProfile.fromJson(Map<String, dynamic> j) => RtkProfile(
        id: j['id'] as String,
        name: j['name'] as String,
        host: j['host'] as String,
        port: j['port'] as int? ?? 2101,
        mountpoint: j['mountpoint'] as String,
        username: j['username'] as String? ?? '',
        active: j['active'] as bool? ?? false,
      );
}

class GnssSample {
  const GnssSample({
    required this.latitude,
    required this.longitude,
    required this.altitude,
    required this.sigmaH,
    required this.sigmaV,
    required this.fixType,
    required this.tier,
    required this.timestamp,
    this.dualFrequency = false,
    this.correctionAgeSec,
  });

  final double latitude;
  final double longitude;
  final double altitude;
  final double sigmaH;
  final double sigmaV;
  final GnssFixType fixType;
  final GnssTier tier;
  final DateTime timestamp;
  final bool dualFrequency;
  final double? correctionAgeSec;

  LatLng get latLng => LatLng(latitude, longitude);
}

class PoseLine {
  PoseLine({
    required this.frameIndex,
    required this.latitude,
    required this.longitude,
    required this.heightMeters,
    required this.covarianceEnuM2,
    required this.fixType,
    required this.tier,
    required this.timestampUtc,
  });

  final int frameIndex;
  final double latitude;
  final double longitude;
  final double heightMeters;
  final List<double> covarianceEnuM2;
  final String fixType;
  final String tier;
  final DateTime timestampUtc;

  Map<String, dynamic> toJson() => {
        'frameIndex': frameIndex,
        'latitudeDegrees': latitude,
        'longitudeDegrees': longitude,
        'heightMeters': heightMeters,
        'heightSemantic': 'ellipsoid',
        'covarianceEnuM2': covarianceEnuM2,
        'fixType': fixType,
        'tier': tier,
        'source': 'fusedGnss',
        'role': 'priorOnly',
        'usedForReconstruction': true,
        'timestampUtc': timestampUtc.toUtc().toIso8601String(),
      };

  String toJsonLine() => jsonEncode(toJson());
}

String newId() => const Uuid().v4();
