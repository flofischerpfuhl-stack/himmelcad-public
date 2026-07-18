#!/usr/bin/env python3
"""Convert the pinned DeDoDe-v2-G models into offline ONNX graphs.

This is a build-time tool only. Release packages execute the resulting graphs
with ONNX Runtime and never include PyTorch, torchvision, OpenMP, or libgomp.
"""

from __future__ import annotations

import argparse
import inspect
import pathlib
import sys
import types


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--runtime-root", type=pathlib.Path, default=pathlib.Path("vendor/dedode/dev"))
    parser.add_argument(
        "--onnx-python-root", type=pathlib.Path, default=pathlib.Path(".build/dedode-convert")
    )
    parser.add_argument(
        "--output", type=pathlib.Path, default=pathlib.Path("vendor/dedode/onnx")
    )
    parser.add_argument("--height", type=int, default=784)
    parser.add_argument("--width", type=int, default=784)
    return parser.parse_args()


def force_float32(torch, model) -> None:
    model.float()
    for module in model.modules():
        if hasattr(module, "amp"):
            module.amp = False
        if hasattr(module, "amp_dtype"):
            module.amp_dtype = torch.float32
    frozen = getattr(getattr(model, "encoder", None), "frozen_dinov2", None)
    if frozen is not None:
        frozen.amp = False
        frozen.amp_dtype = torch.float32
        frozen.dinov2_vitl14[0] = frozen.dinov2_vitl14[0].float()


def load_state(torch, path: pathlib.Path):
    options = {"map_location": "cpu"}
    if "weights_only" in inspect.signature(torch.load).parameters:
        options["weights_only"] = True
    return torch.load(path, **options)


def freeze_dinov2_position_encoding(torch, descriptor, height: int, width: int) -> None:
    dinov2 = descriptor.encoder.frozen_dinov2.dinov2_vitl14[0]
    token_count = (height // 14) * (width // 14) + 1
    tokens = torch.empty((1, token_count, dinov2.pos_embed.shape[-1]), dtype=torch.float32)
    fixed = dinov2.interpolate_pos_encoding(tokens, height, width).detach()
    dinov2.register_buffer("_himmelcad_fixed_position_encoding", fixed, persistent=False)

    def fixed_position_encoding(self, x, _width, _height):
        return self._himmelcad_fixed_position_encoding.to(dtype=x.dtype, device=x.device)

    dinov2.interpolate_pos_encoding = types.MethodType(fixed_position_encoding, dinov2)


def main() -> int:
    args = parse_arguments()
    runtime_root = args.runtime_root.resolve(strict=True)
    onnx_python_root = args.onnx_python_root.resolve(strict=True)
    output = args.output.resolve()
    if args.height % 14 or args.width % 14:
        raise ValueError("example dimensions must be divisible by 14")
    sys.path.insert(0, str(onnx_python_root))
    sys.path.insert(0, str(runtime_root / "DeDoDe-6d156183f4dc84cd704ae779eebc8350995c5b06"))
    sys.modules.setdefault("cv2", types.ModuleType("cv2"))

    import onnx
    import torch
    from DeDoDe import dedode_descriptor_G, dedode_detector_L

    detector = dedode_detector_L(
        device="cpu", weights=load_state(torch, runtime_root / "models/dedode_detector_L_v2.pth")
    )
    descriptor = dedode_descriptor_G(
        device="cpu",
        weights=load_state(torch, runtime_root / "models/dedode_descriptor_G.pth"),
        dinov2_weights=load_state(torch, runtime_root / "models/dinov2_vitl14_pretrain.pth"),
    )
    force_float32(torch, detector)
    force_float32(torch, descriptor)
    freeze_dinov2_position_encoding(torch, descriptor, args.height, args.width)
    detector.eval()
    descriptor.eval()

    class DetectorGraph(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, image):
            return self.model({"image": image})["keypoint_logits"]

    class DescriptorGraph(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, image):
            return self.model({"image": image})["description_grid"]

    output.mkdir(parents=True, exist_ok=True)
    example = torch.zeros((1, 3, args.height, args.width), dtype=torch.float32)
    descriptor_output = output / f"{args.width}x{args.height}"
    descriptor_output.mkdir(parents=True, exist_ok=True)
    graphs = [
        (output / "dedode-detector-l-v2.onnx", DetectorGraph(detector), "keypoint_logits", True),
        (
            descriptor_output / "dedode-descriptor-g.onnx",
            DescriptorGraph(descriptor),
            "description_grid",
            False,
        ),
    ]
    for path, model, output_name, dynamic in graphs:
        with torch.inference_mode():
            torch.onnx.export(
                model,
                (example,),
                str(path),
                input_names=["image"],
                output_names=[output_name],
                opset_version=17,
                dynamic_axes=(
                    {
                        "image": {0: "batch", 2: "height", 3: "width"},
                        output_name: {0: "batch", 2: "height", 3: "width"},
                    }
                    if dynamic
                    else None
                ),
                external_data=True,
                do_constant_folding=True,
            )
        onnx.checker.check_model(str(path), full_check=True)
        print(f"validated {path}", flush=True)

    class BlockSimilarityGraph(torch.nn.Module):
        def forward(self, left, right):
            return left @ right.transpose(0, 1)

    matcher_path = output / "dedode-block-similarity.onnx"
    descriptor_dimension = 256
    matcher_left = torch.zeros((2, descriptor_dimension), dtype=torch.float32)
    matcher_right = torch.zeros((3, descriptor_dimension), dtype=torch.float32)
    torch.onnx.export(
        BlockSimilarityGraph(),
        (matcher_left, matcher_right),
        str(matcher_path),
        input_names=["left", "right"],
        output_names=["similarity"],
        opset_version=17,
        dynamic_axes={
            "left": {0: "left_features"},
            "right": {0: "right_features"},
            "similarity": {0: "left_features", 1: "right_features"},
        },
    )
    onnx.checker.check_model(str(matcher_path), full_check=True)
    print(f"validated {matcher_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
