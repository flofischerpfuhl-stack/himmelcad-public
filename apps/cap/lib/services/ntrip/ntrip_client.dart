import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

/// Minimal NTRIP client (NTRIPv1). Streams RTCM bytes for the RTK engine.
/// License-clean pure Dart — no GPL dependency.
class NtripClient extends ChangeNotifier {
  Socket? _socket;
  StreamSubscription<List<int>>? _sub;
  final _rtcmController = StreamController<Uint8List>.broadcast();

  bool connected = false;
  String? lastError;
  DateTime? lastByteAt;
  int bytesReceived = 0;

  Stream<Uint8List> get rtcmStream => _rtcmController.stream;

  double? get correctionAgeSec {
    if (lastByteAt == null) return null;
    return DateTime.now().difference(lastByteAt!).inMilliseconds / 1000.0;
  }

  Future<void> connect({
    required String host,
    required int port,
    required String mountpoint,
    String username = '',
    String password = '',
  }) async {
    await disconnect();
    lastError = null;
    try {
      final socket = await Socket.connect(host, port, timeout: const Duration(seconds: 12));
      _socket = socket;
      final auth = base64Encode(utf8.encode('$username:$password'));
      final req = StringBuffer()
        ..writeln('GET /$mountpoint HTTP/1.0')
        ..writeln('User-Agent: himmel-cap/0.1 NTRIP')
        ..writeln('Accept: */*')
        ..writeln('Connection: close');
      if (username.isNotEmpty || password.isNotEmpty) {
        req.writeln('Authorization: Basic $auth');
      }
      req.writeln();
      socket.write(req.toString());
      await socket.flush();

      var headerDone = false;
      final headerBuf = BytesBuilder();
      _sub = socket.listen(
        (data) {
          if (!headerDone) {
            headerBuf.add(data);
            final bytes = headerBuf.toBytes();
            final text = utf8.decode(bytes, allowMalformed: true);
            final idx = text.indexOf('\r\n\r\n');
            if (idx < 0) return;
            final header = text.substring(0, idx);
            if (!header.contains('200') && !header.toUpperCase().contains('ICY 200')) {
              lastError = 'NTRIP error: ${header.split('\n').first}';
              connected = false;
              notifyListeners();
              disconnect();
              return;
            }
            headerDone = true;
            connected = true;
            notifyListeners();
            // Prefer original buffer after headers (binary-safe).
            final splitAt = _findHeaderEnd(bytes);
            if (splitAt >= 0 && splitAt < bytes.length) {
              final body = Uint8List.sublistView(bytes, splitAt);
              if (body.isNotEmpty) {
                bytesReceived += body.length;
                lastByteAt = DateTime.now();
                _rtcmController.add(body);
              }
            }
            return;
          }
          final chunk = Uint8List.fromList(data);
          bytesReceived += chunk.length;
          lastByteAt = DateTime.now();
          _rtcmController.add(chunk);
          notifyListeners();
        },
        onError: (Object e) {
          lastError = e.toString();
          connected = false;
          notifyListeners();
        },
        onDone: () {
          connected = false;
          notifyListeners();
        },
        cancelOnError: true,
      );
    } catch (e) {
      lastError = e.toString();
      connected = false;
      notifyListeners();
    }
  }

  int _findHeaderEnd(Uint8List bytes) {
    for (var i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] == 13 &&
          bytes[i + 1] == 10 &&
          bytes[i + 2] == 13 &&
          bytes[i + 3] == 10) {
        return i + 4;
      }
    }
    return -1;
  }

  /// Optional GGA for VRS mountpoints.
  void sendGga(String nmeaGgaSentence) {
    final s = _socket;
    if (s == null || !connected) return;
    s.write(nmeaGgaSentence.endsWith('\r\n') ? nmeaGgaSentence : '$nmeaGgaSentence\r\n');
  }

  Future<void> disconnect() async {
    await _sub?.cancel();
    _sub = null;
    await _socket?.close();
    _socket = null;
    connected = false;
    if (!_disposed) notifyListeners();
  }

  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    _sub?.cancel();
    _sub = null;
    _socket?.destroy();
    _socket = null;
    if (!_rtcmController.isClosed) {
      _rtcmController.close();
    }
    super.dispose();
  }
}
