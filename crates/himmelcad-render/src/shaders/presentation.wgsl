@group(0) @binding(0)
var linear_frame: texture_2d<f32>;

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

@fragment
fn fragment_encoded(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let linear = textureLoad(linear_frame, vec2<i32>(position.xy), 0);
    return vec4<f32>(linear_to_srgb(linear.rgb), linear.a);
}

@fragment
fn fragment_linear(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return textureLoad(linear_frame, vec2<i32>(position.xy), 0);
}
