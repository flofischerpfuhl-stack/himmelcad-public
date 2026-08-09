import 'package:flutter/material.dart';

import '../data/models.dart';
import '../features/capture/capture_screen.dart';
import '../features/job/job_screen.dart';
import '../features/map/map_screen.dart';
import '../features/menu/menu_screen.dart';
import '../features/settings/settings_screen.dart';

enum CapRoute { map, menu, settings, capture, job }

class CapApp extends StatefulWidget {
  const CapApp({super.key, this.brightnessOverride});

  final Brightness? brightnessOverride;

  @override
  State<CapApp> createState() => _CapAppState();
}

class _CapAppState extends State<CapApp> {
  CapRoute _route = CapRoute.map;
  Job? _job;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 160),
      child: switch (_route) {
        CapRoute.map => MapScreen(
            key: const ValueKey('map'),
            onOpenSettings: () => setState(() => _route = CapRoute.settings),
            onOpenMenu: () => setState(() => _route = CapRoute.menu),
            onOpenCapture: () => setState(() => _route = CapRoute.capture),
            onOpenJob: (j) => setState(() {
              _job = j;
              _route = CapRoute.job;
            }),
          ),
        CapRoute.menu => MenuScreen(
            key: const ValueKey('menu'),
            onBack: () => setState(() => _route = CapRoute.map),
            onOpenJob: (j) => setState(() {
              _job = j;
              _route = CapRoute.job;
            }),
          ),
        CapRoute.settings => SettingsScreen(
            key: const ValueKey('settings'),
            onBack: () => setState(() => _route = CapRoute.map),
          ),
        CapRoute.capture => CaptureScreen(
            key: const ValueKey('capture'),
            onBack: () => setState(() => _route = CapRoute.map),
            onJobSaved: (j) => setState(() {
              _job = j;
              _route = j.status == JobStatus.draft ? CapRoute.menu : CapRoute.job;
            }),
          ),
        CapRoute.job => JobScreen(
            key: ValueKey(_job?.id ?? 'job'),
            job: _job!,
            onBack: () => setState(() => _route = CapRoute.map),
          ),
      },
    );
  }
}
