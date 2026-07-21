import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';

import 'app/cap_app.dart';
import 'l10n/app_localizations.dart';
import 'services/cloud/cloud_scaffold.dart';
import 'services/gnss/gnss_engine.dart';
import 'services/storage/app_store.dart';
import 'theme/hc_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = AppStore();
  await store.load();
  final gnss = GnssEngine();
  await gnss.start();
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: store),
        ChangeNotifierProvider.value(value: gnss),
        ChangeNotifierProvider(create: (_) => CloudScaffold()),
      ],
      child: const HimmelCapRoot(),
    ),
  );
}

class HimmelCapRoot extends StatelessWidget {
  const HimmelCapRoot({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final locale = Locale(store.localeCode);
    final brightness = switch (store.themeMode) {
      'light' => Brightness.light,
      'dark' => Brightness.dark,
      _ => MediaQuery.platformBrightnessOf(context),
    };

    return MaterialApp(
      title: 'himmel:Cap',
      debugShowCheckedModeBanner: false,
      locale: locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: hcTheme(brightness: Brightness.light),
      darkTheme: hcTheme(brightness: Brightness.dark),
      themeMode: switch (store.themeMode) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      },
      home: CapApp(brightnessOverride: brightness),
    );
  }
}
