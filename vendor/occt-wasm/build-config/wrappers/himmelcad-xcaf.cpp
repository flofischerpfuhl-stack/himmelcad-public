// SPDX-License-Identifier: LGPL-2.1-only
// Part of the HimmelCAD OCCT WebAssembly build (vendor/occt-wasm). This file
// is compiled into the LGPL OCCT module, so it is distributed under the
// module's license (LGPL-2.1-only, see LICENSES/THIRD_PARTY.md).
//
// Embind-friendly reads of an XCAF document (after STEPCAFControl_Reader).
// opencascade.js binds TDF_Label and the XCAFDoc tools, but not
// Standard_GUID (needed by TDF_Label::FindAttribute) nor the base class of
// TDF_LabelSequence, so neither the TDataStd_Name of a label nor
// XCAFDoc_ShapeTool::GetComponents is reachable from JS. This facade returns
// the name as UTF-8 and enumerates child labels in document order.

#include <TCollection_AsciiString.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_Label.hxx>
#include <TDataStd_Name.hxx>

#include <string>

class HimmelcadXcaf {
public:
  HimmelcadXcaf() {}

  /** The label's TDataStd_Name as UTF-8, "" when it has none. */
  std::string Name(const TDF_Label& label) const {
    if (label.IsNull()) return std::string();
    Handle(TDataStd_Name) attribute;
    if (!label.FindAttribute(TDataStd_Name::GetID(), attribute) || attribute.IsNull()) {
      return std::string();
    }
    // Without a replacement character OCCT converts to UTF-8.
    TCollection_AsciiString utf8(attribute->Get());
    return std::string(utf8.ToCString(), static_cast<size_t>(utf8.Length()));
  }

  /** Number of direct children of `label`. */
  int ChildCount(const TDF_Label& label) const {
    return label.IsNull() ? 0 : label.NbChildren();
  }

  /** The `index`-th (0-based) direct child in document order; a null label past the end. */
  TDF_Label Child(const TDF_Label& label, int index) const {
    if (label.IsNull() || index < 0) return TDF_Label();
    int i = 0;
    for (TDF_ChildIterator it(label, Standard_False); it.More(); it.Next(), ++i) {
      if (i == index) return it.Value();
    }
    return TDF_Label();
  }
};
