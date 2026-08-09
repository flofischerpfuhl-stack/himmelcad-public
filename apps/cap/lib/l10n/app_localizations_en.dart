// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'himmel:Cap';

  @override
  String get settings => 'Settings';

  @override
  String get jobs => 'Jobs';

  @override
  String get appearance => 'Appearance';

  @override
  String get theme => 'Theme';

  @override
  String get themeDark => 'Dark';

  @override
  String get themeLight => 'Light';

  @override
  String get themeSystem => 'System';

  @override
  String get rtkNtrip => 'RTK / NTRIP';

  @override
  String get addProfile => 'Add profile';

  @override
  String get cloud => 'Cloud';

  @override
  String get googleDrive => 'Google Drive';

  @override
  String get dropbox => 'Dropbox';

  @override
  String get oneDrive => 'OneDrive';

  @override
  String get link => 'Link';

  @override
  String get unlink => 'Unlink';

  @override
  String get autoUpload => 'Auto-upload after capture';

  @override
  String get on => 'On';

  @override
  String get off => 'Off';

  @override
  String get asBuiltFolder => 'As-built plan folder (DXF)';

  @override
  String get choose => 'Choose';

  @override
  String get about => 'About';

  @override
  String get overview => 'Overview';

  @override
  String get gnss => 'GNSS';

  @override
  String get corrections => 'Corrections';

  @override
  String get media => 'Media';

  @override
  String get package => 'Package';

  @override
  String get notes => 'Notes';

  @override
  String get addNote => 'Add note';

  @override
  String get shareHcap => 'Share .hcap';

  @override
  String get cloudUpload => 'Cloud';

  @override
  String get saveJob => 'Save job';

  @override
  String get name => 'Name';

  @override
  String get descriptionOptional => 'Description (optional)';

  @override
  String get save => 'Save';

  @override
  String get cancel => 'Cancel';

  @override
  String get packing => 'Building package in background…';

  @override
  String get packageReady => '.hcap ready';

  @override
  String get rec => 'REC';

  @override
  String frames(int count) {
    return '$count frames';
  }

  @override
  String get active => 'active';

  @override
  String get draft => 'draft';

  @override
  String get openJob => 'Open job';

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
  String get username => 'Username';

  @override
  String get password => 'Password';

  @override
  String get create => 'Create';

  @override
  String get gnssNoCorrection => 'No corrections';

  @override
  String get gnssFloat => 'Float';

  @override
  String get gnssFix => 'Fix';

  @override
  String get gnssPhoneOnly => 'Phone GPS only';

  @override
  String sigmaLine(String h, String v) {
    return 'H ~$h m · V ~$v m';
  }

  @override
  String get mapAttribution => '© Esri';

  @override
  String get quality => 'Quality';

  @override
  String get device => 'Device';

  @override
  String get dualFreq => 'Dual-freq';

  @override
  String get yes => 'yes';

  @override
  String get no => 'no';

  @override
  String get profile => 'Profile';

  @override
  String get file => 'File';

  @override
  String get status => 'Status';

  @override
  String get ready => 'ready';

  @override
  String get noteText => 'Text';

  @override
  String get append => 'Append';

  @override
  String get noNotes => 'No notes';

  @override
  String get cloudScaffold =>
      'Cloud providers scaffolded — full OAuth in a later release.';

  @override
  String get dxfScaffold =>
      'DXF folder sync scaffolded for office as-built overlays.';
}
