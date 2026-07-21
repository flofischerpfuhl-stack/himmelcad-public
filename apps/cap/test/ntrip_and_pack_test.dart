import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:himmel_cap/data/models.dart';
import 'package:himmel_cap/services/ntrip/ntrip_client.dart';
import 'package:himmel_cap/services/pack/hcap_packer.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

class _FakePathProvider extends Fake
    with MockPlatformInterfaceMixin
    implements PathProviderPlatform {
  _FakePathProvider(this.root);
  final String root;

  @override
  Future<String?> getTemporaryPath() async => root;

  @override
  Future<String?> getApplicationDocumentsPath() async => root;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('NtripClient starts disconnected', () {
    final c = NtripClient();
    expect(c.connected, isFalse);
    expect(c.correctionAgeSec, isNull);
    c.dispose();
  });

  test('HcapPacker writes valid zip with manifest and poses', () async {
    final tmp = await Directory.systemTemp.createTemp('hcap_test_');
    PathProviderPlatform.instance = _FakePathProvider(tmp.path);

    final frame = File(p.join(tmp.path, 'f.jpg'));
    await frame.writeAsBytes(
      Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xD9, 1, 2, 3, 4]),
    );

    final job = Job(
      id: 'session-1',
      projectId: 'p1',
      name: 'Pack Test',
      createdAt: DateTime.utc(2026, 7, 21, 10),
      description: 'note',
      sigmaH: 0.4,
      sigmaV: 0.8,
      quality: 'float',
    );
    final poses = [
      PoseLine(
        frameIndex: 0,
        latitude: 48.1,
        longitude: 11.5,
        heightMeters: 500,
        covarianceEnuM2: const [0.16, 0, 0, 0, 0.16, 0, 0, 0, 0.64],
        fixType: 'float',
        tier: 't2NtripFloat',
        timestampUtc: DateTime.utc(2026, 7, 21, 10),
      ),
    ];

    final out = await HcapPacker().pack(
      job: job,
      projectName: 'Proj',
      frameFiles: [frame],
      poses: poses,
    );
    expect(out.existsSync(), isTrue);
    expect(out.path.endsWith('.hcap'), isTrue);

    final bytes = await out.readAsBytes();
    final archive = ZipDecoder().decodeBytes(bytes);
    final names = archive.files.map((f) => f.name).toSet();
    expect(names.contains('manifest.json'), isTrue);
    expect(names.contains('poses.jsonl'), isTrue);
    expect(names.contains('checksums.sha256'), isTrue);
    expect(names.any((n) => n.startsWith('media/frames/')), isTrue);

    final manifestFile = archive.files.firstWhere((f) => f.name == 'manifest.json');
    final manifest = String.fromCharCodes(manifestFile.content as List<int>);
    expect(manifest.contains('himmelcap-session'), isTrue);
    expect(manifest.contains('office'), isTrue);

    await tmp.delete(recursive: true);
  });
}
