@group(0) @binding(0)
var linear_frame: texture_2d<f32>;
@group(0) @binding(1)
var scene_depth: texture_depth_2d;

struct PresentationEffects {
    edl_taps: u32,
    radius_pixels: f32,
    strength: f32,
    padding: u32,
}
@group(0) @binding(2)
var<uniform> effects: PresentationEffects;

const FULLSCREEN_POSITIONS: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(3.0, 1.0),
    vec2<f32>(-1.0, -3.0),
);

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(FULLSCREEN_POSITIONS[vertex_index], 0.0, 1.0);
    return output;
}

fn linear_to_srgb(linear: vec3<f32>) -> vec3<f32> {
    let value = max(linear, vec3<f32>(0.0));
    let low = value * 12.92;
    let high = 1.055 * pow(value, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, value <= vec3<f32>(0.0031308));
}

fn edl_shade(pixel: vec2<i32>) -> f32 {
    if (effects.edl_taps == 0u) {
        return 1.0;
    }
    let size = vec2<i32>(textureDimensions(scene_depth));
    let center = textureLoad(scene_depth, clamp(pixel, vec2<i32>(0), size - vec2<i32>(1)), 0);
    if (center <= 0.0) {
        return 1.0;
    }
    let radius = max(i32(round(effects.radius_pixels)), 1);
    let offsets = array<vec2<i32>, 4>(
        vec2<i32>(radius, 0),
        vec2<i32>(0, radius),
        vec2<i32>(radius, radius),
        vec2<i32>(radius, -radius),
    );
    var obscurance = 0.0;
    for (var index = 0u; index < effects.edl_taps; index++) {
        let offset = offsets[index];
        let positive = textureLoad(scene_depth, clamp(pixel + offset, vec2<i32>(0), size - vec2<i32>(1)), 0);
        let negative = textureLoad(scene_depth, clamp(pixel - offset, vec2<i32>(0), size - vec2<i32>(1)), 0);
        obscurance += max(positive - center, 0.0) + max(negative - center, 0.0);
    }
    return clamp(exp(-effects.strength * obscurance / f32(effects.edl_taps * 2u)), 0.62, 1.0);
}

fn effected_linear(position: vec4<f32>) -> vec4<f32> {
    let pixel = vec2<i32>(position.xy);
    let linear = textureLoad(linear_frame, pixel, 0);
    return vec4<f32>(linear.rgb * edl_shade(pixel), linear.a);
}

@fragment
fn fragment_encoded(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let linear = effected_linear(position);
    return vec4<f32>(linear_to_srgb(linear.rgb), linear.a);
}

@fragment
fn fragment_encoded_straight_alpha(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let linear = effected_linear(position);
    let straight = select(vec3<f32>(0.0), linear.rgb / max(linear.a, 1.0e-6), linear.a > 1.0e-6);
    return vec4<f32>(linear_to_srgb(straight), linear.a);
}

@fragment
fn fragment_linear(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return effected_linear(position);
}
