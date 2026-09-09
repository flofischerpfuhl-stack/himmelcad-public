/**
 * Vertical alignment segment in station/elevation space.
 */
export type VerticalAlignmentSegment = {
    "kind": "grade";
    startStation: number;
    startElevation: number;
    grade: number;
    length: number;
} | {
    "kind": "parabolic";
    startStation: number;
    startElevation: number;
    startGrade: number;
    endGrade: number;
    length: number;
};
//# sourceMappingURL=VerticalAlignmentSegment.d.ts.map