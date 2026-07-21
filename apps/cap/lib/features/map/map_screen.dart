import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../../data/models.dart';
import '../../l10n/app_localizations.dart';
import '../../services/storage/app_store.dart';
import '../../theme/hc_theme.dart';
import '../../widgets/hc_island.dart';

class MapScreen extends StatefulWidget {
  const MapScreen({
    super.key,
    required this.onOpenSettings,
    required this.onOpenMenu,
    required this.onOpenCapture,
    required this.onOpenJob,
  });

  final VoidCallback onOpenSettings;
  final VoidCallback onOpenMenu;
  final VoidCallback onOpenCapture;
  final void Function(Job job) onOpenJob;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> {
  final _map = MapController();
  bool _projectMenu = false;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final l10n = AppLocalizations.of(context);
    final project = store.activeProject;
    final jobs = project.jobs.where((j) => j.showOnMap).toList();

    return Stack(
      children: [
        FlutterMap(
          mapController: _map,
          options: MapOptions(
            initialCenter: jobs.isNotEmpty && jobs.first.path.isNotEmpty
                ? jobs.first.path.first
                : const LatLng(48.1378, 11.5755),
            initialZoom: 16,
            onTap: (_, __) => setState(() => _projectMenu = false),
          ),
          children: [
            TileLayer(
              urlTemplate:
                  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
              userAgentPackageName: 'de.himmelcad.cap',
            ),
            PolylineLayer(
              polylines: [
                for (final j in jobs)
                  if (j.path.length >= 2)
                    Polyline(
                      points: j.path,
                      strokeWidth: 4,
                      color: j.quality == 'fix'
                          ? HcTokens.success
                          : j.quality == 'single'
                              ? HcTokens.warning
                              : HcTokens.accent,
                    ),
              ],
            ),
            MarkerLayer(
              markers: [
                for (final j in jobs)
                  if (j.path.isNotEmpty)
                    Marker(
                      point: j.path.first,
                      width: 28,
                      height: 28,
                      child: GestureDetector(
                        onTap: () => _showJobSheet(context, j),
                        child: Container(
                          decoration: BoxDecoration(
                            color: HcTokens.accent,
                            shape: BoxShape.circle,
                            border: Border.all(color: Colors.white, width: 2),
                          ),
                        ),
                      ),
                    ),
              ],
            ),
          ],
        ),
        // Top island
        Positioned(
          top: MediaQuery.paddingOf(context).top + 8,
          left: 12,
          right: 12,
          child: HcIsland(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Row(
              children: [
                IconButton(
                  onPressed: widget.onOpenMenu,
                  icon: const Icon(LucideIcons.menu, size: 20),
                ),
                Expanded(
                  child: InkWell(
                    borderRadius: BorderRadius.circular(8),
                    onTap: () => setState(() => _projectMenu = !_projectMenu),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Flexible(
                            child: Text(
                              project.name,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 13,
                              ),
                            ),
                          ),
                          const SizedBox(width: 4),
                          const Icon(LucideIcons.chevronDown, size: 16),
                        ],
                      ),
                    ),
                  ),
                ),
                IconButton(
                  onPressed: widget.onOpenSettings,
                  icon: const Icon(LucideIcons.settings, size: 20),
                ),
              ],
            ),
          ),
        ),
        if (_projectMenu)
          Positioned(
            top: MediaQuery.paddingOf(context).top + 60,
            left: 48,
            right: 48,
            child: HcIsland(
              padding: const EdgeInsets.all(4),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final p in store.projects)
                    ListTile(
                      dense: true,
                      title: Text(p.name, style: const TextStyle(fontSize: 13)),
                      trailing: p.id == project.id
                          ? const Icon(LucideIcons.check, size: 16)
                          : null,
                      onTap: () async {
                        await store.setActiveProject(p.id);
                        setState(() => _projectMenu = false);
                      },
                    ),
                ],
              ),
            ),
          ),
        Positioned(
          left: 12,
          bottom: 118,
          child: HcIsland(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Text(
              l10n.mapAttribution,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(fontSize: 9),
            ),
          ),
        ),
        Positioned(
          left: 16,
          right: 16,
          bottom: 28,
          child: Row(
            children: [
              HcIsland(
                padding: EdgeInsets.zero,
                child: IconButton(
                  onPressed: () {
                    final c = jobs.isNotEmpty && jobs.first.path.isNotEmpty
                        ? jobs.first.path.first
                        : const LatLng(48.1378, 11.5755);
                    _map.move(c, 17);
                  },
                  icon: const Icon(LucideIcons.locateFixed, size: 20),
                ),
              ),
              const Spacer(),
              Material(
                color: HcTokens.accent,
                shape: const CircleBorder(
                  side: BorderSide(color: Colors.white, width: 3),
                ),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: widget.onOpenCapture,
                  child: const SizedBox(
                    width: 76,
                    height: 76,
                    child: Center(
                      child: Text(
                        'REC',
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const Spacer(),
              const SizedBox(width: 48),
            ],
          ),
        ),
      ],
    );
  }

  void _showJobSheet(BuildContext context, Job job) {
    final l10n = AppLocalizations.of(context);
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(job.name, style: Theme.of(ctx).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              job.createdAt.toLocal().toString(),
              style: Theme.of(ctx).textTheme.labelSmall,
            ),
            if (job.description.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(job.description),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () {
                Navigator.pop(ctx);
                widget.onOpenJob(job);
              },
              child: Text(l10n.openJob),
            ),
          ],
        ),
      ),
    );
  }
}
