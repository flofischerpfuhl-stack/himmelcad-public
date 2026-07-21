// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for German (`de`).
class AppLocalizationsDe extends AppLocalizations {
  AppLocalizationsDe([String locale = 'de']) : super(locale);

  @override
  String get appTitle => 'himmel:Cap';

  @override
  String get settings => 'Einstellungen';

  @override
  String get jobs => 'Jobs';

  @override
  String get appearance => 'Darstellung';

  @override
  String get theme => 'Theme';

  @override
  String get themeDark => 'Dunkel';

  @override
  String get themeLight => 'Hell';

  @override
  String get themeSystem => 'System';

  @override
  String get rtkNtrip => 'RTK / NTRIP';

  @override
  String get addProfile => 'Profil hinzufügen';

  @override
  String get cloud => 'Cloud';

  @override
  String get googleDrive => 'Google Drive';

  @override
  String get dropbox => 'Dropbox';

  @override
  String get oneDrive => 'OneDrive';

  @override
  String get link => 'Verknüpfen';

  @override
  String get unlink => 'Trennen';

  @override
  String get autoUpload => 'Auto-Upload nach Capture';

  @override
  String get on => 'An';

  @override
  String get off => 'Aus';

  @override
  String get asBuiltFolder => 'Bestandsplan-Ordner (DXF)';

  @override
  String get choose => 'Wählen';

  @override
  String get about => 'Über';

  @override
  String get overview => 'Überblick';

  @override
  String get gnss => 'GNSS';

  @override
  String get corrections => 'Korrekturen';

  @override
  String get media => 'Medien';

  @override
  String get package => 'Paket';

  @override
  String get notes => 'Notizen';

  @override
  String get addNote => 'Notiz hinzufügen';

  @override
  String get shareHcap => '.hcap teilen';

  @override
  String get cloudUpload => 'Cloud';

  @override
  String get saveJob => 'Job speichern';

  @override
  String get name => 'Name';

  @override
  String get descriptionOptional => 'Beschreibung (optional)';

  @override
  String get save => 'Speichern';

  @override
  String get cancel => 'Abbrechen';

  @override
  String get packing => 'Paket wird im Hintergrund gebaut…';

  @override
  String get packageReady => '.hcap bereit';

  @override
  String get rec => 'REC';

  @override
  String frames(int count) {
    return '$count Frames';
  }

  @override
  String get active => 'aktiv';

  @override
  String get draft => 'Entwurf';

  @override
  String get openJob => 'Job öffnen';

  @override
  String get testConnection => 'Test';

  @override
  String get profileName => 'Name';

  @override
  String get host => 'Host';

  @override
  String get port => 'Port';

  @override
  String get mountpoint => 'Mountpoint';

  @override
  String get username => 'Benutzer';

  @override
  String get password => 'Passwort';

  @override
  String get create => 'Anlegen';

  @override
  String get gnssNoCorrection => 'Keine Korrektur';

  @override
  String get gnssFloat => 'Float';

  @override
  String get gnssFix => 'Fix';

  @override
  String get gnssPhoneOnly => 'Nur Handy-GPS';

  @override
  String sigmaLine(String h, String v) {
    return 'Lage ~$h m · Höhe ~$v m';
  }

  @override
  String get mapAttribution => '© Esri';

  @override
  String get quality => 'Qualität';

  @override
  String get device => 'Gerät';

  @override
  String get dualFreq => 'Dual-Freq';

  @override
  String get yes => 'ja';

  @override
  String get no => 'nein';

  @override
  String get profile => 'Profil';

  @override
  String get file => 'Datei';

  @override
  String get status => 'Status';

  @override
  String get ready => 'bereit';

  @override
  String get noteText => 'Text';

  @override
  String get append => 'Anhängen';

  @override
  String get noNotes => 'Keine Notizen';

  @override
  String get cloudScaffold =>
      'Cloud-Provider vorbereitet — volles OAuth folgt.';

  @override
  String get dxfScaffold =>
      'DXF-Ordner-Sync vorbereitet für Bestandsplan-Overlay.';
}
