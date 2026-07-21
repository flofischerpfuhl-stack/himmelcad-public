import 'package:flutter/material.dart';

/// HimmelCAD design tokens (ported from packages/@himmelcad/theme).
abstract final class HcTokens {
  static const voidDark = Color(0xFF101114);
  static const islandDark = Color(0xFF1A1C20);
  static const islandHiDark = Color(0xFF1F2226);
  static const islandLoDark = Color(0xFF15171A);
  static const voidLight = Color(0xFFF1F2F5);
  static const islandLight = Color(0xFFFFFFFF);
  static const islandHiLight = Color(0xFFF7F8FA);
  static const accent = Color(0xFF1597F2);
  static const accentHover = Color(0xFF2EA6F7);
  static const success = Color(0xFF73B00A);
  static const warning = Color(0xFFE8A33E);
  static const error = Color(0xFFF75464);
  static const radiusIsland = 10.0;
  static const fontUi = 'Inter';
  static const fontDisplay = 'HCWordmark';
  static const fontMono = 'JetBrains Mono';
}

ThemeData hcTheme({required Brightness brightness}) {
  final dark = brightness == Brightness.dark;
  final bg = dark ? HcTokens.voidDark : HcTokens.voidLight;
  final island = dark ? HcTokens.islandDark : HcTokens.islandLight;
  final fg = dark ? const Color(0xFFC9CCD2) : const Color(0xFF3C4048);
  final fgStrong = dark ? const Color(0xFFF0F1F3) : const Color(0xFF12141A);
  final muted = dark ? const Color(0xFF7A7E85) : const Color(0xFF6B7280);

  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: ColorScheme(
      brightness: brightness,
      primary: HcTokens.accent,
      onPrimary: Colors.white,
      secondary: HcTokens.accent,
      onSecondary: Colors.white,
      error: HcTokens.error,
      onError: Colors.white,
      surface: island,
      onSurface: fgStrong,
    ),
    scaffoldBackgroundColor: bg,
    fontFamily: 'Roboto',
    textTheme: TextTheme(
      titleLarge: TextStyle(
        fontFamily: HcTokens.fontDisplay,
        fontSize: 18,
        letterSpacing: 0.4,
        color: fgStrong,
      ),
      titleMedium: TextStyle(fontWeight: FontWeight.w600, color: fgStrong),
      bodyMedium: TextStyle(color: fg, fontSize: 13),
      bodySmall: TextStyle(color: muted, fontSize: 11),
      labelSmall: TextStyle(
        fontFamily: 'monospace',
        color: muted,
        fontSize: 11,
      ),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: island,
      foregroundColor: fgStrong,
      elevation: 0,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: bg,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(6),
        borderSide: BorderSide(
          color: dark ? const Color(0x1AFFFFFF) : const Color(0x1A000000),
        ),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
    ),
  );
  return base;
}
