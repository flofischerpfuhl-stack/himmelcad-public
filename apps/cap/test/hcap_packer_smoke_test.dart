import 'package:flutter_test/flutter_test.dart';
import 'package:himmel_cap/data/models.dart';

void main() {
  test('pose line json is priorOnly', () {
    final pose = PoseLine(
      frameIndex: 0,
      latitude: 48.1,
      longitude: 11.5,
      heightMeters: 500,
      covarianceEnuM2: const [0.09, 0, 0, 0, 0.09, 0, 0, 0, 0.36],
      fixType: 'float',
      tier: 't2NtripFloat',
      timestampUtc: DateTime.utc(2026, 7, 21),
    );
    final j = pose.toJson();
    expect(j['role'], 'priorOnly');
    expect(j['latitudeDegrees'], 48.1);
  });

  test('draft jobs do not show on map', () {
    final job = Job(
      id: '1',
      projectId: 'p',
      name: 'x',
      createdAt: DateTime.now(),
      status: JobStatus.draft,
    );
    expect(job.showOnMap, isFalse);
  });
}
