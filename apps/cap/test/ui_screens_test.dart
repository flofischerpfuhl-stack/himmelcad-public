import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:himmel_cap/data/models.dart';
import 'package:himmel_cap/features/job/job_screen.dart';
import 'package:himmel_cap/features/map/map_screen.dart';
import 'package:himmel_cap/features/menu/menu_screen.dart';
import 'package:himmel_cap/features/settings/settings_screen.dart';
import 'package:himmel_cap/l10n/app_localizations.dart';
import 'package:himmel_cap/services/cloud/cloud_scaffold.dart';
import 'package:himmel_cap/services/gnss/gnss_engine.dart';
import 'package:himmel_cap/services/storage/app_store.dart';
import 'package:himmel_cap/theme/hc_theme.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// UI regression: each main screen must render and match golden PNGs.
/// Goldens live under test/goldens/ — regenerate with:
///   flutter test --update-goldens test/ui_screens_test.dart
///
/// Prototype reference (visual design intent):
///   ../cap-prototype/screenshots/*.png
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStore store;
  late GnssEngine gnss;
  late CloudScaffold cloud;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    store = AppStore();
    await store.load();
    gnss = GnssEngine();
    // Don't start location stream in unit tests.
    cloud = CloudScaffold();
  });

  Widget wrap(Widget child, {Locale locale = const Locale('de')}) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: store),
        ChangeNotifierProvider.value(value: gnss),
        ChangeNotifierProvider.value(value: cloud),
      ],
      child: MaterialApp(
        locale: locale,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppLocalizations.supportedLocales,
        theme: hcTheme(brightness: Brightness.dark),
        home: MediaQuery(
          data: const MediaQueryData(size: Size(390, 844)),
          child: child,
        ),
      ),
    );
  }

  Future<void> golden(WidgetTester tester, String name) async {
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/$name.png'),
    );
  }

  testWidgets('map screen golden', (tester) async {
    // Seed path for polylines
    final p = store.activeProject;
    if (p.jobs.isNotEmpty && p.jobs.first.path.isEmpty) {
      p.jobs.first.path.addAll(const [
        LatLng(48.1372, 11.575),
        LatLng(48.1375, 11.5758),
      ]);
    }
    await tester.pumpWidget(
      wrap(
        MapScreen(
          onOpenSettings: () {},
          onOpenMenu: () {},
          onOpenCapture: () {},
          onOpenJob: (_) {},
          enableNetworkTiles: false,
        ),
      ),
    );
    // Map tiles may not load offline; allow partial settle.
    await tester.pump(const Duration(milliseconds: 500));
    await golden(tester, '01_map');
  });

  testWidgets('menu projects/jobs golden', (tester) async {
    await tester.pumpWidget(
      wrap(MenuScreen(onBack: () {}, onOpenJob: (_) {})),
    );
    await golden(tester, '05_menu');
  });

  testWidgets('settings golden de', (tester) async {
    await tester.pumpWidget(
      wrap(SettingsScreen(onBack: () {})),
    );
    await golden(tester, '06_settings_de');
  });

  testWidgets('settings golden en', (tester) async {
    await tester.pumpWidget(
      wrap(SettingsScreen(onBack: () {}), locale: const Locale('en')),
    );
    await golden(tester, '06_settings_en');
  });

  testWidgets('job detail golden', (tester) async {
    final job = store.activeProject.jobs.isNotEmpty
        ? store.activeProject.jobs.first
        : Job(
            id: 'j',
            projectId: store.activeProject.id,
            name: 'Test Job',
            createdAt: DateTime(2026, 7, 21, 12),
            description: 'desc',
          );
    await tester.pumpWidget(
      wrap(JobScreen(job: job, onBack: () {})),
    );
    await golden(tester, '03_job');
  });

  testWidgets('draft jobs hidden from map filter', (tester) async {
    final draft = Job(
      id: newId(),
      projectId: store.activeProject.id,
      name: 'Draft only',
      createdAt: DateTime.now(),
      status: JobStatus.draft,
    );
    await store.upsertJob(draft);
    final visible = store.activeProject.jobs.where((j) => j.showOnMap);
    expect(visible.any((j) => j.id == draft.id), isFalse);
    expect(store.activeProject.jobs.any((j) => j.id == draft.id), isTrue);
  });

  testWidgets('l10n settings title DE vs EN', (tester) async {
    await tester.pumpWidget(wrap(SettingsScreen(onBack: () {})));
    expect(find.text('Einstellungen'), findsOneWidget);

    await tester.pumpWidget(
      wrap(SettingsScreen(onBack: () {}), locale: const Locale('en')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Settings'), findsOneWidget);
  });

  test('prototype screenshot baseline exists', () {
    final dir = Directory(
      '${Directory.current.path}/../cap-prototype/screenshots',
    );
    expect(dir.existsSync(), isTrue, reason: 'prototype screenshots missing');
    final pngs = dir.listSync().whereType<File>().where((f) => f.path.endsWith('.png'));
    expect(pngs.length, greaterThanOrEqualTo(15));
  });
}
