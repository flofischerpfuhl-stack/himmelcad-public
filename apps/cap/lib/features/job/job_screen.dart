import 'package:flutter/material.dart';

import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../data/models.dart';
import '../../l10n/app_localizations.dart';
import '../../services/cloud/cloud_scaffold.dart';
import '../../services/storage/app_store.dart';

class JobScreen extends StatelessWidget {
  const JobScreen({
    super.key,
    required this.job,
    required this.onBack,
  });

  final Job job;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final store = context.watch<AppStore>();
    final cloud = context.watch<CloudScaffold>();
    final projectName = store.projects
        .firstWhere((p) => p.id == job.projectId, orElse: () => store.activeProject)
        .name;

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.chevron_left),
          onPressed: onBack,
        ),
        title: Text('Job', style: Theme.of(context).textTheme.titleLarge),
        centerTitle: true,
      ),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Text(job.name, style: Theme.of(context).textTheme.titleMedium),
          Text(
            '$projectName · ${job.createdAt.toLocal()}',
            style: Theme.of(context).textTheme.labelSmall,
          ),
          if (job.description.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(job.description),
          ],
          if (job.status == JobStatus.draft)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Chip(label: Text(l10n.draft)),
            ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: job.hcapPath == null
                      ? null
                      : () => Share.shareXFiles([XFile(job.hcapPath!)]),
                  child: Text(l10n.shareHcap),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: () async {
                    final ok = await cloud.uploadHcap(
                      provider: CloudProvider.googleDrive,
                      localPath: job.hcapPath ?? '',
                      remoteName: '${job.name}.hcap',
                    );
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(
                          content: Text(
                            ok ? l10n.cloudUpload : l10n.cloudScaffold,
                          ),
                        ),
                      );
                    }
                  },
                  child: Text(l10n.cloudUpload),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _tile(context, l10n.overview, initiallyExpanded: true, child: Column(
            children: [
              _kv(l10n.quality, job.quality),
              _kv('σ H', '${job.sigmaH.toStringAsFixed(2)} m'),
              _kv('σ V', '${job.sigmaV.toStringAsFixed(2)} m'),
              _kv('Fix/Float', '${job.fixPct}% / ${job.floatPct}%'),
              _kv(l10n.media, '${job.frameCount}'),
            ],
          )),
          _tile(context, l10n.notes, initiallyExpanded: true, child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (job.notes.isEmpty)
                Text(l10n.noNotes, style: Theme.of(context).textTheme.bodySmall)
              else
                for (var i = 0; i < job.notes.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        CircleAvatar(
                          radius: 10,
                          child: Text('${i + 1}', style: const TextStyle(fontSize: 10)),
                        ),
                        const SizedBox(width: 8),
                        Expanded(child: Text(job.notes[i])),
                      ],
                    ),
                  ),
              OutlinedButton(
                onPressed: () => _addNote(context, store),
                child: Text(l10n.addNote),
              ),
            ],
          )),
        ],
      ),
    );
  }

  Widget _tile(
    BuildContext context,
    String title, {
    required Widget child,
    bool initiallyExpanded = false,
  }) {
    return Card(
      child: ExpansionTile(
        initiallyExpanded: initiallyExpanded,
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        children: [child],
      ),
    );
  }

  Widget _kv(String k, String v) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(child: Text(k)),
          Text(v, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
        ],
      ),
    );
  }

  Future<void> _addNote(BuildContext context, AppStore store) async {
    final l10n = AppLocalizations.of(context);
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l10n.addNote),
        content: TextField(
          controller: ctrl,
          maxLines: 3,
          decoration: InputDecoration(labelText: l10n.noteText),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(l10n.cancel)),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(l10n.append)),
        ],
      ),
    );
    if (ok == true && ctrl.text.trim().isNotEmpty) {
      await store.appendNote(job.id, ctrl.text.trim());
    }
  }
}
