import 'package:flutter/material.dart';

import '../theme/hc_theme.dart';

class HcIsland extends StatelessWidget {
  const HcIsland({super.key, required this.child, this.padding});

  final Widget child;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: padding ?? const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: dark ? HcTokens.islandDark : HcTokens.islandLight,
        borderRadius: BorderRadius.circular(HcTokens.radiusIsland),
        border: Border.all(
          color: dark ? const Color(0x0DFFFFFF) : const Color(0x0F000000),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: dark ? 0.55 : 0.08),
            blurRadius: dark ? 2 : 3,
            offset: const Offset(0, 1),
          ),
        ],
      ),
      child: child,
    );
  }
}
