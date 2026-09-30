// SPDX-License-Identifier: LGPL-2.1-only
// Part of the HimmelCAD OCCT WebAssembly build (vendor/occt-wasm). This file
// is compiled into the LGPL OCCT module, so it is distributed under the
// module's license (LGPL-2.1-only, see LICENSES/THIRD_PARTY.md).
//
// Embind-friendly facade over BRepOffset_MakeOffset. opencascade.js excludes
// the class itself from binding generation (bindgen-filters.yaml lists it
// under "Undefined symbols": some declared members have no definition), so
// only the members defined in OCCT 8.0.1 are exposed here. Enum parameters
// are passed as integers (BRepOffset_Mode, GeomAbs_JoinType) and OCCT
// exceptions are caught and reported through ErrorMessage() instead of
// crossing the wasm boundary.

#include <BRepOffset_MakeOffset.hxx>
#include <Message_ProgressRange.hxx>
#include <Standard_Failure.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>

#include <string>

class HimmelcadOffset {
public:
  HimmelcadOffset() {}

  void Initialize(const TopoDS_Shape& shape,
                  double offset,
                  double tolerance,
                  int mode,
                  bool intersection,
                  bool selfInter,
                  int join,
                  bool thickening,
                  bool removeIntEdges) {
    myError.clear();
    myOffset.Initialize(shape, offset, tolerance, static_cast<BRepOffset_Mode>(mode), intersection,
                        selfInter, static_cast<GeomAbs_JoinType>(join), thickening,
                        removeIntEdges);
  }

  void SetOffsetOnFace(const TopoDS_Face& face, double offset) {
    myOffset.SetOffsetOnFace(face, offset);
  }

  void AddFace(const TopoDS_Face& face) { myOffset.AddFace(face); }

  bool MakeOffsetShape() {
    try {
      Message_ProgressRange range;
      myOffset.MakeOffsetShape(range);
    } catch (const Standard_Failure& failure) {
      myError = failure.what() ? failure.what() : "Standard_Failure";
      return false;
    }
    return myOffset.IsDone();
  }

  bool MakeThickSolid() {
    try {
      Message_ProgressRange range;
      myOffset.MakeThickSolid(range);
    } catch (const Standard_Failure& failure) {
      myError = failure.what() ? failure.what() : "Standard_Failure";
      return false;
    }
    return myOffset.IsDone();
  }

  bool IsDone() const { return myOffset.IsDone(); }

  TopoDS_Shape Shape() const { return myOffset.Shape(); }

  int Error() const { return static_cast<int>(myOffset.Error()); }

  std::string ErrorMessage() const { return myError; }

  TopTools_ListOfShape Generated(const TopoDS_Shape& shape) {
    return myOffset.Generated(shape);
  }

  TopTools_ListOfShape Modified(const TopoDS_Shape& shape) {
    return myOffset.Modified(shape);
  }

  bool IsDeleted(const TopoDS_Shape& shape) { return myOffset.IsDeleted(shape); }

private:
  BRepOffset_MakeOffset myOffset;
  std::string myError;
};
