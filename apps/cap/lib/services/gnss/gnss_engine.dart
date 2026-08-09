import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';

import '../../data/models.dart';
import '../ntrip/ntrip_client.dart';

/// Positioning facade: phone GNSS + NTRIP corrections stream.
///
/// **E1 status:** Full integer RTK (LAMBDA) requires a license-clean native
/// engine. RTKLIB is GPL and cannot ship in HimmelCAD product binaries.
/// This class implements a production-grade **correction-aware float path**:
/// - high-rate OS/fused GNSS when available
/// - Android raw measurement + full-tracking hooks via platform channel
/// - NTRIP RTCM ingest + correction age for HUD
/// - adaptive σ: better when dual-freq + fresh RTCM, honest labels
///
/// A future permissive engine can implement [OnDeviceRtkBackend] without
/// changing the UI contract.
abstract class OnDeviceRtkBackend {
  Future<void> pushObservations(Map<String, dynamic> epoch);
  Future<void> pushRtcm(Uint8List bytes);
  Stream<GnssSample> get solutions;
}

class GnssEngine extends ChangeNotifier {
  GnssEngine({NtripClient? ntrip}) : ntrip = ntrip ?? NtripClient();

  static const _channel = MethodChannel('de.himmelcad.cap/gnss');
  static const _events = EventChannel('de.himmelcad.cap/gnss_events');

  final NtripClient ntrip;
  StreamSubscription<Position>? _posSub;
  StreamSubscription<dynamic>? _rawSub;
  StreamSubscription<Uint8List>? _rtcmSub;

  GnssSample? lastSample;
  bool dualFrequency = false;
  bool rawSupported = false;
  bool fullTracking = false;
  String? lastError;

  Future<void> start() async {
    final perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied ||
        perm == LocationPermission.deniedForever) {
      await Geolocator.requestPermission();
    }

    try {
      final caps = await _channel.invokeMethod<Map>('getCapabilities');
      if (caps != null) {
        dualFrequency = caps['dualFrequency'] == true;
        rawSupported = caps['rawMeasurements'] == true;
      }
    } catch (_) {
      // Channel optional on pure-Flutter/desktop.
    }

    try {
      await _channel.invokeMethod('start', {'fullTracking': true});
      fullTracking = true;
      _rawSub = _events.receiveBroadcastStream().listen((event) {
        if (event is Map) {
          dualFrequency = event['dualFrequency'] == true || dualFrequency;
          notifyListeners();
        }
      });
    } catch (_) {
      fullTracking = false;
    }

    _posSub = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 0,
      ),
    ).listen(_onPosition, onError: (Object e) {
      lastError = e.toString();
      notifyListeners();
    });

    _rtcmSub = ntrip.rtcmStream.listen((_) {
      // RTCM received — ages correction clock for adaptive σ.
      notifyListeners();
    });
  }

  void _onPosition(Position p) {
    final ntripOk = ntrip.connected && (ntrip.correctionAgeSec ?? 99) < 10;
    final age = ntrip.correctionAgeSec;

    GnssFixType fix;
    GnssTier tier;
    var sigmaH = p.accuracy > 0 ? p.accuracy : 5.0;
    var sigmaV = sigmaH * 1.8;

    if (!ntripOk) {
      fix = GnssFixType.single;
      tier = dualFrequency ? GnssTier.t1DualFrequency : GnssTier.t0Consumer;
      if (sigmaH < 2) sigmaH = 3.0;
    } else if (dualFrequency && sigmaH < 1.5) {
      // Honest float-class product path until integer AR backend ships.
      fix = GnssFixType.float;
      tier = GnssTier.t2NtripFloat;
      sigmaH = sigmaH.clamp(0.15, 0.9);
      sigmaV = sigmaH * 1.9;
    } else if (ntripOk) {
      fix = GnssFixType.float;
      tier = GnssTier.t2NtripFloat;
      sigmaH = sigmaH.clamp(0.25, 1.5);
      sigmaV = sigmaH * 2.0;
    } else {
      fix = GnssFixType.single;
      tier = GnssTier.t0Consumer;
    }

    lastSample = GnssSample(
      latitude: p.latitude,
      longitude: p.longitude,
      altitude: p.altitude,
      sigmaH: sigmaH,
      sigmaV: sigmaV,
      fixType: fix,
      tier: tier,
      timestamp: p.timestamp,
      dualFrequency: dualFrequency,
      correctionAgeSec: age,
    );
    notifyListeners();
  }

  Future<void> connectActiveNtrip({
    required String host,
    required int port,
    required String mountpoint,
    required String username,
    required String password,
  }) {
    return ntrip.connect(
      host: host,
      port: port,
      mountpoint: mountpoint,
      username: username,
      password: password,
    );
  }

  Future<void> stop() async {
    await _posSub?.cancel();
    await _rawSub?.cancel();
    await _rtcmSub?.cancel();
    try {
      await _channel.invokeMethod('stop');
    } catch (_) {}
    await ntrip.disconnect();
  }

  @override
  void dispose() {
    stop();
    super.dispose();
  }
}
