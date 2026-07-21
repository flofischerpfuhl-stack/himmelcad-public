import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../../data/models.dart';
import '../../l10n/app_localizations.dart';
import '../../services/cloud/cloud_scaffold.dart';
import '../../services/gnss/gnss_engine.dart';
import '../../services/storage/app_store.dart';
import '../../theme/hc_theme.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final store = context.watch<AppStore>();
    final cloud = context.watch<CloudScaffold>();
    final gnss = context.watch<GnssEngine>();

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(LucideIcons.chevronLeft),
          onPressed: onBack,
        ),
        title: Text(l10n.settings, style: Theme.of(context).textTheme.titleLarge),
        centerTitle: true,
      ),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _section(context, l10n.appearance, [
            ListTile(
              title: Text(l10n.theme),
              trailing: SegmentedButton<String>(
                segments: [
                  ButtonSegment(value: 'dark', label: Text(l10n.themeDark)),
                  ButtonSegment(value: 'light', label: Text(l10n.themeLight)),
                  ButtonSegment(value: 'system', label: Text(l10n.themeSystem)),
                ],
                selected: {store.themeMode},
                onSelectionChanged: (s) => store.setThemeMode(s.first),
              ),
            ),
            ListTile(
              title: const Text('Language / Sprache'),
              trailing: SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'de', label: Text('DE')),
                  ButtonSegment(value: 'en', label: Text('EN')),
                ],
                selected: {store.localeCode},
                onSelectionChanged: (s) => store.setLocaleCode(s.first),
              ),
            ),
          ]),
          _section(context, l10n.rtkNtrip, [
            for (final p in store.rtkProfiles)
              ListTile(
                leading: Icon(
                  p.active ? LucideIcons.circleDot : LucideIcons.circle,
                  color: p.active ? HcTokens.accent : null,
                  size: 18,
                ),
                title: Text(p.name),
                subtitle: Text(p.detail, style: Theme.of(context).textTheme.bodySmall),
                trailing: TextButton(
                  onPressed: () => _testNtrip(context, p, gnss),
                  child: Text(l10n.testConnection),
                ),
                selected: p.active,
                onTap: () => store.setActiveRtk(p.id),
              ),
            ListTile(
              leading: const Icon(LucideIcons.plus),
              title: Text(l10n.addProfile),
              onTap: () => _addRtk(context, store),
            ),
          ]),
          _section(context, l10n.cloud, [
            for (final e in {
              CloudProvider.googleDrive: l10n.googleDrive,
              CloudProvider.dropbox: l10n.dropbox,
              CloudProvider.oneDrive: l10n.oneDrive,
            }.entries)
              ListTile(
                title: Text(e.value),
                trailing: TextButton(
                  onPressed: () => cloud.toggleLink(e.key),
                  child: Text(
                    cloud.links[e.key]!.linked ? l10n.unlink : l10n.link,
                  ),
                ),
                subtitle: Text(
                  cloud.links[e.key]!.linked ? 'OK' : '—',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            SwitchListTile(
              title: Text(l10n.autoUpload),
              value: store.autoUpload,
              onChanged: store.setAutoUpload,
            ),
            ListTile(
              title: Text(l10n.asBuiltFolder),
              trailing: TextButton(
                onPressed: () {
                  cloud.asBuiltDxfFolderHint = '/HimmelCAD Cap/Bestandsplan';
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(l10n.dxfScaffold)),
                  );
                },
                child: Text(l10n.choose),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                l10n.cloudScaffold,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ]),
          _section(context, l10n.about, [
            ListTile(
              title: Text(l10n.appTitle),
              subtitle: Text(
                'v0.1.0 · dualFreq=${gnss.dualFrequency} raw=${gnss.rawSupported}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _section(BuildContext context, String title, List<Widget> children) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: Text(
              title.toUpperCase(),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    letterSpacing: 0.8,
                    fontWeight: FontWeight.w600,
                  ),
            ),
          ),
          Card(
            margin: EdgeInsets.zero,
            child: Column(children: children),
          ),
        ],
      ),
    );
  }

  Future<void> _addRtk(BuildContext context, AppStore store) async {
    final l10n = AppLocalizations.of(context);
    final name = TextEditingController();
    final host = TextEditingController();
    final port = TextEditingController(text: '2101');
    final mount = TextEditingController();
    final user = TextEditingController();
    final pass = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l10n.addProfile),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: name, decoration: InputDecoration(labelText: l10n.profileName)),
              TextField(controller: host, decoration: InputDecoration(labelText: l10n.host)),
              TextField(controller: port, decoration: InputDecoration(labelText: l10n.port)),
              TextField(controller: mount, decoration: InputDecoration(labelText: l10n.mountpoint)),
              TextField(controller: user, decoration: InputDecoration(labelText: l10n.username)),
              TextField(
                controller: pass,
                decoration: InputDecoration(labelText: l10n.password),
                obscureText: true,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(l10n.cancel)),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(l10n.create)),
        ],
      ),
    );
    if (ok != true) return;
    final id = newId();
    final profile = RtkProfile(
      id: id,
      name: name.text.trim().isEmpty ? 'NTRIP' : name.text.trim(),
      host: host.text.trim(),
      port: int.tryParse(port.text.trim()) ?? 2101,
      mountpoint: mount.text.trim(),
      username: user.text.trim(),
      active: true,
    );
    await store.addRtkProfile(profile);
    const secure = FlutterSecureStorage();
    await secure.write(key: 'ntrip.password.$id', value: pass.text);
  }

  Future<void> _testNtrip(BuildContext context, RtkProfile p, GnssEngine gnss) async {
    final l10n = AppLocalizations.of(context);
    const secure = FlutterSecureStorage();
    final password = await secure.read(key: 'ntrip.password.${p.id}') ?? '';
    // Optional dev override from environment — never logged.
    final envUser = String.fromEnvironment('HCAP_NTRIP_USER', defaultValue: '');
    final envPass = String.fromEnvironment('HCAP_NTRIP_PASS', defaultValue: '');
    final envHost = String.fromEnvironment('HCAP_NTRIP_HOST', defaultValue: '');
    final envMount = String.fromEnvironment('HCAP_NTRIP_MOUNT', defaultValue: '');

    final host = p.host.isEmpty ? envHost : p.host;
    final mount = p.mountpoint.isEmpty ? envMount : p.mountpoint;
    final user = p.username.isEmpty ? envUser : p.username;
    final pass = password.isEmpty ? envPass : password;

    if (host.isEmpty || mount.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Host/mountpoint missing')),
        );
      }
      return;
    }

    await gnss.connectActiveNtrip(
      host: host,
      port: p.port,
      mountpoint: mount,
      username: user,
      password: pass,
    );
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          gnss.ntrip.connected
              ? '${l10n.testConnection}: OK'
              : '${l10n.testConnection}: ${gnss.ntrip.lastError ?? "fail"}',
        ),
      ),
    );
  }
}
