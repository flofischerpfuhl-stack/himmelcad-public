import 'package:flutter/material.dart';

import 'package:provider/provider.dart';

import '../../data/models.dart';
import '../../l10n/app_localizations.dart';
import '../../services/storage/app_store.dart';
import '../../theme/hc_theme.dart';

class MenuScreen extends StatefulWidget {
  const MenuScreen({
    super.key,
    required this.onBack,
    required this.onOpenJob,
  });

  final VoidCallback onBack;
  final void Function(Job job) onOpenJob;

  @override
  State<MenuScreen> createState() => _MenuScreenState();
}

class _MenuScreenState extends State<MenuScreen> {
  final _expanded = <String>{};

  @override
  void initState() {
    super.initState();
    final store = context.read<AppStore>();
    _expanded.addAll(store.projects.map((p) => p.id));
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final l10n = AppLocalizations.of(context);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.chevron_left),
          onPressed: widget.onBack,
        ),
        title: Text(l10n.jobs, style: Theme.of(context).textTheme.titleLarge),
        centerTitle: true,
      ),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          for (final p in store.projects) ...[
            Card(
              child: Column(
                children: [
                  ListTile(
                    leading: IconButton(
                      icon: Icon(
                        _expanded.contains(p.id)
                            ? Icons.keyboard_arrow_down
                            : Icons.chevron_right,
                        size: 18,
                      ),
                      onPressed: () {
                        setState(() {
                          if (_expanded.contains(p.id)) {
                            _expanded.remove(p.id);
                          } else {
                            _expanded.add(p.id);
                          }
                        });
                      },
                    ),
                    title: Text(p.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                    trailing: p.id == store.activeProject.id
                        ? Chip(
                            label: Text(l10n.active, style: const TextStyle(fontSize: 10)),
                            visualDensity: VisualDensity.compact,
                            backgroundColor: HcTokens.accent.withValues(alpha: 0.15),
                          )
                        : null,
                    onTap: () async {
                      await store.setActiveProject(p.id);
                      widget.onBack();
                    },
                  ),
                  if (_expanded.contains(p.id))
                    for (final j in p.jobs)
                      ListTile(
                        contentPadding: const EdgeInsets.only(left: 56, right: 16),
                        title: Text(j.name, style: const TextStyle(fontSize: 13)),
                        subtitle: Text(
                          '${j.createdAt.toLocal()} · ${j.status == JobStatus.draft ? l10n.draft : j.quality}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        trailing: j.status == JobStatus.draft
                            ? Chip(
                                label: Text(l10n.draft, style: const TextStyle(fontSize: 10)),
                                visualDensity: VisualDensity.compact,
                              )
                            : null,
                        onTap: () => widget.onOpenJob(j),
                      ),
                ],
              ),
            ),
            const SizedBox(height: 8),
          ],
        ],
      ),
    );
  }
}
