/** Hand-calculation helpers shared by the acceptance cases (no kernel, no store). */

/** Area of a W × H rectangle with four corners rounded to R. */
export const roundedRectArea = (w: number, h: number, r: number): number =>
  w * h - (4 - Math.PI) * r * r;
