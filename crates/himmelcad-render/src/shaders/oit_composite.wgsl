@group(0) @binding(0)
var accumulation_texture: texture_2d<f32>;

@group(0) @binding(1)
var revealage_texture: texture_2d<f32>;

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    let x = f32((vertex_index << 1u) & 2u);
    let y = f32(vertex_index & 2u);
    return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fragment_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pixel = vec2<i32>(position.xy);
    let accumulation = textureLoad(accumulation_texture, pixel, 0);
    let revealage = textureLoad(revealage_texture, pixel, 0).r;
    let alpha = clamp(1.0 - revealage, 0.0, 1.0);
    let straight_color = accumulation.rgb / max(accumulation.a, 0.00001);
    return vec4<f32>(straight_color * alpha, alpha);
}
