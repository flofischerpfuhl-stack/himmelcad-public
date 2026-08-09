import 'package:flutter/foundation.dart';

/// Enterprise-common cloud providers for field→office transfer.
///
/// Scaffold only for v1: OAuth clients are not embedded. Wire real SDKs later
/// (Google Drive Android/iOS, Dropbox SDK, Microsoft Graph / MSAL).
enum CloudProvider { googleDrive, dropbox, oneDrive }

class CloudLinkState {
  CloudLinkState({
    this.linked = false,
    this.displayName,
    this.folderHint,
  });

  bool linked;
  String? displayName;
  String? folderHint;
}

class CloudScaffold extends ChangeNotifier {
  final Map<CloudProvider, CloudLinkState> links = {
    for (final p in CloudProvider.values) p: CloudLinkState(),
  };

  bool autoUpload = false;
  String? asBuiltDxfFolderHint;

  Future<void> toggleLink(CloudProvider p) async {
    final s = links[p]!;
    s.linked = !s.linked;
    s.displayName = s.linked ? 'linked (scaffold)' : null;
    notifyListeners();
  }

  /// Placeholder upload — returns false until OAuth is configured.
  Future<bool> uploadHcap({
    required CloudProvider provider,
    required String localPath,
    required String remoteName,
  }) async {
    if (!(links[provider]?.linked ?? false)) return false;
    // Scaffold: no network OAuth yet.
    debugPrint('cloud scaffold upload $remoteName via $provider from $localPath');
    return false;
  }

  /// Placeholder pull for office Bestandsplan.dxf.
  Future<String?> pullAsBuiltDxf() async {
    debugPrint('cloud scaffold DXF pull from $asBuiltDxfFolderHint');
    return null;
  }
}
