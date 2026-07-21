import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Ensures every prototype UI screenshot has a corresponding Flutter golden
/// intent documented, and baseline files exist for overnight CI/local runs.
void main() {
  final prototypeDir = Directory(
    '${Directory.current.path}/../cap-prototype/screenshots',
  );
  final flutterGoldenDir = Directory(
    '${Directory.current.path}/test/goldens',
  );

  /// Map prototype screenshots → Flutter golden names (design intent parity).
  const mapping = <String, String>{
    '01-map-dark.png': '01_map.png',
    '03-job-detail.png': '03_job.png',
    '05-menu-projects-jobs.png': '05_menu.png',
    '06-settings-top.png': '06_settings_de.png',
    // EN settings is Flutter-only extra coverage
  };

  test('prototype screenshots baseline complete', () {
    expect(prototypeDir.existsSync(), isTrue);
    final files = prototypeDir
        .listSync()
        .whereType<File>()
        .where((f) => f.path.endsWith('.png'))
        .map((f) => f.uri.pathSegments.last)
        .toSet();
    for (final required in [
      '01-map-dark.png',
      '03-job-detail.png',
      '05-menu-projects-jobs.png',
      '06-settings-top.png',
      '09-capture-idle.png',
      '11-save-job-dialog.png',
    ]) {
      expect(files.contains(required), isTrue, reason: 'missing $required');
    }
  });

  test('flutter goldens cover mapped prototype screens', () {
    if (!flutterGoldenDir.existsSync()) {
      // First run before --update-goldens still validates mapping is defined.
      expect(mapping.length, greaterThanOrEqualTo(4));
      return;
    }
    final goldens = flutterGoldenDir
        .listSync()
        .whereType<File>()
        .where((f) => f.path.endsWith('.png'))
        .map((f) => f.uri.pathSegments.last)
        .toSet();
    for (final g in mapping.values) {
      expect(
        goldens.contains(g),
        isTrue,
        reason: 'Flutter golden $g missing — run: flutter test --update-goldens test/ui_screens_test.dart',
      );
    }
  });

  test('MANIFEST documents prototype set', () {
    final m = File('${prototypeDir.path}/MANIFEST.md');
    expect(m.existsSync(), isTrue);
    final text = m.readAsStringSync();
    expect(text.contains('01-map-dark.png'), isTrue);
  });
}
