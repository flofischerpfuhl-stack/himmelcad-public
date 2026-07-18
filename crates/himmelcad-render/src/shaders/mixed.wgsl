struct FrameUniform {
    view_projection: mat4x4<f32>,
    inverse_view_projection: mat4x4<f32>,
    clip_planes: array<vec4<f32>, 24>,
    clip_volume_meta: array<vec4<u32>, 4>,
    viewport_size: vec2<f32>,
    clip_volume_count: u32,
    _padding_0: u32,
}

@group(0) @binding(0)
var<uniform> frame: FrameUniform;

struct MaterialUniform {
    alpha_cutoff: f32,
    alpha_mode: u32,
    color_mode: u32,
    gradient_count: u32,
    base_color: vec4<f32>,
    source_color: vec4<f32>,
    source_emissive: vec4<f32>,
    source_pbr_values: vec4<f32>,
    source_texture_flags: vec4<u32>,
    source_uv_rows: array<vec4<f32>, 10>,
    style_values: vec4<f32>,
    height_values: vec4<f32>,
    gradient_colors: array<vec4<f32>, 256>,
    hatch_origin_width: vec4<f32>,
    hatch_axis_u_count: vec4<f32>,
    hatch_color: vec4<f32>,
    hatch_axis_v_texture_width: vec4<f32>,
    stroke_color: vec4<f32>,
    stroke_values: vec4<f32>,
    stroke_modes: vec4<u32>,
    line_type_values: vec4<f32>,
    interaction_translation: vec4<f32>,
    batch_origin_delta: vec4<f32>,
    source_linear_rows: array<vec4<f32>, 3>,
    source_normal_rows: array<vec4<f32>, 3>,
}

@group(1) @binding(0)
var base_color_texture: texture_2d<f32>;
@group(1) @binding(1)
var base_color_sampler: sampler;
@group(1) @binding(2)
var<uniform> material: MaterialUniform;
@group(1) @binding(3)
var line_type_texture: texture_2d<f32>;
@group(1) @binding(4)
var hatch_texture: texture_2d<f32>;
@group(1) @binding(5)
var normal_texture: texture_2d<f32>;
@group(1) @binding(6)
var normal_sampler: sampler;
@group(1) @binding(7)
var metallic_roughness_texture: texture_2d<f32>;
@group(1) @binding(8)
var metallic_roughness_sampler: sampler;
@group(1) @binding(9)
var emissive_texture: texture_2d<f32>;
@group(1) @binding(10)
var emissive_sampler: sampler;
@group(1) @binding(11)
var occlusion_texture: texture_2d<f32>;
@group(1) @binding(12)
var occlusion_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) proxy_slot: u32,
    @location(3) primitive_slot: u32,
}

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) render_position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) @interpolate(flat) proxy_slot: u32,
    @location(3) @interpolate(flat) primitive_slot: u32,
    @location(4) tex_coord: vec2<f32>,
    @location(5) shape_coord: vec2<f32>,
    @location(6) @interpolate(flat) shape_kind: u32,
    @location(7) style_position: vec3<f32>,
    @location(8) normal: vec3<f32>,
    @location(9) source_render_position: vec3<f32>,
    @location(10) stroke_half_width: f32,
}

struct MeshVertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) proxy_slot: u32,
    @location(3) primitive_slot: u32,
    @location(4) normal: vec4<f32>,
    @location(5) tex_coord: vec2<f32>,
}

struct MeshInstanceInput {
    @location(6) row_0: vec4<f32>,
    @location(7) row_1: vec4<f32>,
    @location(8) row_2: vec4<f32>,
    @location(9) proxy_slot: u32,
    @location(10) primitive_offset: u32,
    @location(11) normal_row_0: vec4<f32>,
    @location(12) normal_row_1: vec4<f32>,
    @location(13) normal_row_2: vec4<f32>,
}

struct PointInstanceInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) proxy_slot: u32,
    @location(3) primitive_slot: u32,
    @location(4) point_size: f32,
    @location(5) civil_0: u32,
    @location(6) civil_1: u32,
}

struct LineInstanceInput {
    @location(0) start: vec3<f32>,
    @location(1) end: vec3<f32>,
    @location(2) color: vec4<f32>,
    @location(3) proxy_slot: u32,
    @location(4) primitive_slot: u32,
    @location(5) width: f32,
    @location(6) previous: vec3<f32>,
    @location(7) next: vec3<f32>,
    @location(8) path_distance: vec2<f32>,
    @location(9) path_meta: vec2<u32>,
}

struct SplatInstanceInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) scale: vec3<f32>,
    @location(3) rotation: vec4<f32>,
    @location(4) proxy_slot: u32,
    @location(5) primitive_slot: u32,
}

struct ScreenTextVertexInput {
    @location(0) anchor: vec3<f32>,
    @location(1) pixel_offset: vec2<f32>,
    @location(2) tex_coord: vec2<f32>,
    @location(3) color: vec4<f32>,
    @location(4) proxy_slot: u32,
    @location(5) primitive_slot: u32,
}

const QUAD_CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
);

fn source_linear_vector(vector: vec3<f32>) -> vec3<f32> {
    let homogeneous = vec4<f32>(vector, 0.0);
    return vec3<f32>(
        dot(material.source_linear_rows[0], homogeneous),
        dot(material.source_linear_rows[1], homogeneous),
        dot(material.source_linear_rows[2], homogeneous),
    );
}

fn source_normal_vector(vector: vec3<f32>) -> vec3<f32> {
    let homogeneous = vec4<f32>(vector, 0.0);
    return normalize(vec3<f32>(
        dot(material.source_normal_rows[0], homogeneous),
        dot(material.source_normal_rows[1], homogeneous),
        dot(material.source_normal_rows[2], homogeneous),
    ));
}

fn translated_position(position: vec3<f32>) -> vec3<f32> {
    return source_linear_vector(position) + material.interaction_translation.xyz;
}

fn styled_position(position: vec3<f32>) -> vec3<f32> {
    let translated = translated_position(position);
    let datum = material.style_values.z;
    return vec3<f32>(
        translated.xy,
        datum + (translated.z - datum) * material.style_values.y,
    );
}

fn styled_direction(direction: vec3<f32>) -> vec3<f32> {
    let placed = source_linear_vector(direction);
    return vec3<f32>(placed.xy, placed.z * material.style_values.y);
}

fn frame_position(batch_position: vec3<f32>) -> vec3<f32> {
    return batch_position + material.batch_origin_delta.xyz;
}

fn height_gradient(height: f32) -> vec4<f32> {
    let count = max(material.gradient_count, 1u);
    let range = max(material.height_values.y - material.height_values.x, 1.0e-12);
    let scaled = clamp(
        (height - material.height_values.x) / range,
        0.0,
        1.0,
    ) * f32(count - 1u);
    let lower = min(u32(floor(scaled)), count - 1u);
    let upper = min(lower + 1u, count - 1u);
    return mix(material.gradient_colors[lower], material.gradient_colors[upper], fract(scaled));
}

fn styled_color(source: vec4<f32>, height: f32, shape_kind: u32) -> vec4<f32> {
    let canonical_source = source * material.source_color;
    var base_color = material.base_color;
    if (shape_kind >= 3u && material.stroke_modes.z == 1u) {
        base_color = material.stroke_color;
    }
    var color = canonical_source * base_color;
    if (material.color_mode == 1u) {
        color = base_color;
    } else if (material.color_mode == 2u) {
        color = height_gradient(height)
            * vec4<f32>(base_color.rgb, canonical_source.a * base_color.a);
    }
    color.a *= material.style_values.x;
    return color;
}

fn source_texture_coordinate(uv: vec2<f32>, channel: u32) -> vec2<f32> {
    let homogeneous = vec3<f32>(uv, 1.0);
    let first_row = min(channel, 4u) * 2u;
    return vec2<f32>(
        dot(material.source_uv_rows[first_row].xyz, homogeneous),
        dot(material.source_uv_rows[first_row + 1u].xyz, homogeneous),
    );
}

fn categorical_point_color(value: u32) -> vec3<f32> {
    // Stable, high-contrast integer hash. This is deliberately evaluated in
    // the shader so changing point styles never rebuilds point geometry.
    let hashed = value * 1664525u + 1013904223u;
    return vec3<f32>(
        f32((hashed >> 0u) & 255u),
        f32((hashed >> 8u) & 255u),
        f32((hashed >> 16u) & 255u),
    ) / 510.0 + vec3<f32>(0.35);
}

fn point_source_color(input: PointInstanceInput) -> vec4<f32> {
    let flags = input.civil_1 >> 24u;
    if (material.color_mode == 3u && (flags & 1u) != 0u) {
        let intensity = f32(input.civil_0 & 65535u) / 65535.0;
        return vec4<f32>(vec3<f32>(intensity), input.color.a);
    }
    if (material.color_mode == 4u && (flags & 2u) != 0u) {
        let classification = (input.civil_0 >> 16u) & 255u;
        if (classification < material.gradient_count) {
            return vec4<f32>(material.gradient_colors[classification].rgb, input.color.a);
        }
        return vec4<f32>(categorical_point_color(classification), input.color.a);
    }
    if (material.color_mode == 5u && (flags & 4u) != 0u) {
        return vec4<f32>(categorical_point_color(input.civil_0 >> 24u), input.color.a);
    }
    if (material.color_mode == 6u && (flags & 8u) != 0u) {
        return vec4<f32>(categorical_point_color(input.civil_1 & 65535u), input.color.a);
    }
    return input.color;
}

fn hatch_entry(index: u32) -> vec4<f32> {
    let width = max(u32(material.hatch_axis_v_texture_width.w), 1u);
    let coordinate = vec2<i32>(i32(index % width), i32(index / width));
    return textureLoad(hatch_texture, coordinate, 0);
}

fn hatch_dash_coverage(
    coordinate: f32,
    period: f32,
    advance_start: u32,
    advance_count: u32,
    dot_start: u32,
    dot_count: u32,
    line_width: f32,
) -> f32 {
    if (advance_count == 0u) {
        return 1.0;
    }
    let wrapped = positive_modulo(coordinate, period);
    var lower = 0u;
    var upper = advance_count;
    loop {
        if (lower >= upper) {
            break;
        }
        let middle = lower + (upper - lower) / 2u;
        if (wrapped < hatch_entry(advance_start + middle).x) {
            upper = middle;
        } else {
            lower = middle + 1u;
        }
    }
    let interval = min(lower, advance_count - 1u);
    var coverage = select(0.0, 1.0, hatch_entry(advance_start + interval).y > 0.5);
    if (dot_count > 0u) {
        var dot_lower = 0u;
        var dot_upper = dot_count;
        loop {
            if (dot_lower >= dot_upper) {
                break;
            }
            let middle = dot_lower + (dot_upper - dot_lower) / 2u;
            if (wrapped < hatch_entry(dot_start + middle).x) {
                dot_upper = middle;
            } else {
                dot_lower = middle + 1u;
            }
        }
        let next = min(dot_lower, dot_count - 1u);
        var previous = next;
        if (dot_lower > 0u) {
            previous = dot_lower - 1u;
        }
        let next_distance = abs(wrapped - hatch_entry(dot_start + next).x);
        let previous_distance = abs(wrapped - hatch_entry(dot_start + previous).x);
        let periodic_distance = min(
            min(next_distance, previous_distance),
            min(period - next_distance, period - previous_distance),
        );
        let antialias = max(fwidth(coordinate), line_width * 1.0e-3);
        coverage = max(
            coverage,
            1.0 - smoothstep(line_width * 0.5, line_width * 0.5 + antialias, periodic_distance),
        );
    }
    return coverage;
}

fn apply_hatch(base: vec4<f32>, position: vec3<f32>) -> vec4<f32> {
    let line_count_value = material.hatch_axis_u_count.w;
    if (line_count_value == 0.0) {
        return base;
    }
    var coverage = select(0.0, 1.0, line_count_value < 0.0);
    let relative = position - material.hatch_origin_width.xyz;
    let pattern_position = vec2<f32>(
        dot(relative, material.hatch_axis_u_count.xyz),
        dot(relative, material.hatch_axis_v_texture_width.xyz),
    );
    let line_width = material.hatch_origin_width.w;
    let line_count = u32(max(line_count_value, 0.0));
    for (var line_index = 0u; line_index < line_count; line_index += 1u) {
        let descriptor_index = line_index * 4u;
        let origin_offset = hatch_entry(descriptor_index);
        let direction_normal = hatch_entry(descriptor_index + 1u);
        let spacing_dash = hatch_entry(descriptor_index + 2u);
        let counts = hatch_entry(descriptor_index + 3u);
        let local = pattern_position - origin_offset.xy;
        let line_number = round(dot(local, direction_normal.zw) / spacing_dash.x);
        let line_origin = origin_offset.xy + line_number * origin_offset.zw;
        let from_line = pattern_position - line_origin;
        let perpendicular = dot(from_line, direction_normal.zw);
        let antialias = max(fwidth(perpendicular), abs(spacing_dash.x) * 1.0e-4);
        let line_coverage = 1.0 - smoothstep(
            line_width * 0.5,
            line_width * 0.5 + antialias,
            abs(perpendicular),
        );
        let dash_coverage = hatch_dash_coverage(
            dot(from_line, direction_normal.xy),
            spacing_dash.z,
            u32(spacing_dash.w),
            u32(counts.x),
            u32(counts.y),
            u32(counts.z),
            line_width,
        );
        coverage = max(coverage, line_coverage * dash_coverage);
    }
    let hatch_alpha = coverage * material.hatch_color.a;
    return vec4<f32>(
        mix(base.rgb, material.hatch_color.rgb, hatch_alpha),
        max(base.a, hatch_alpha),
    );
}

fn safe_pixel_direction(delta: vec2<f32>, fallback: vec2<f32>) -> vec2<f32> {
    let magnitude = length(delta);
    if (magnitude > 1.0e-7) {
        return delta / magnitude;
    }
    return fallback;
}

fn line_type_entry(index: u32) -> vec2<f32> {
    let width = max(u32(material.line_type_values.y), 1u);
    let coordinate = vec2<i32>(i32(index % width), i32(index / width));
    return textureLoad(line_type_texture, coordinate, 0).xy;
}

fn positive_modulo(value: f32, modulus: f32) -> f32 {
    return value - floor(value / modulus) * modulus;
}

fn stroke_chunk_distance(chunk_count: u32, period: f32) -> f32 {
    var remaining = chunk_count;
    var addend = positive_modulo(4096.0, period);
    var result = 0.0;
    for (var bit = 0u; bit < 32u; bit++) {
        if ((remaining & 1u) != 0u) {
            result = positive_modulo(result + addend, period);
        }
        addend = positive_modulo(addend + addend, period);
        remaining >>= 1u;
    }
    return result;
}

struct StrokePatternSample {
    drawn: bool,
    dot_delta: f32,
}

fn circular_pattern_distance(left: f32, right: f32, period: f32) -> f32 {
    let direct = abs(left - right);
    return min(direct, period - direct);
}

fn stroke_pattern_sample(local_distance: f32, path_chunk: u32) -> StrokePatternSample {
    let element_count = material.stroke_modes.w;
    if (element_count == 0u) {
        return StrokePatternSample(true, 1.0e30);
    }
    let period = material.line_type_values.x;
    var coordinate = stroke_chunk_distance(path_chunk, period);
    coordinate = positive_modulo(coordinate + local_distance + material.stroke_values.w, period);
    let advance_count = u32(material.line_type_values.z);
    var lower = 0u;
    var upper = advance_count;
    for (var iteration = 0u; iteration < 17u; iteration++) {
        if (lower < upper) {
            let middle = lower + (upper - lower) / 2u;
            if (coordinate < line_type_entry(middle).x) {
                upper = middle;
            } else {
                lower = middle + 1u;
            }
        }
    }
    let interval = min(lower, advance_count - 1u);
    let drawn = line_type_entry(interval).y > 0.5;

    let dot_count = u32(material.line_type_values.w);
    var nearest_dot = 1.0e30;
    if (dot_count > 0u) {
        lower = 0u;
        upper = dot_count;
        for (var iteration = 0u; iteration < 17u; iteration++) {
            if (lower < upper) {
                let middle = lower + (upper - lower) / 2u;
                let dot_position = line_type_entry(advance_count + middle).x;
                if (dot_position < coordinate) {
                    lower = middle + 1u;
                } else {
                    upper = middle;
                }
            }
        }
        if (lower < dot_count) {
            nearest_dot = circular_pattern_distance(
                coordinate,
                line_type_entry(advance_count + lower).x,
                period,
            );
        }
        if (lower > 0u) {
            nearest_dot = min(
                nearest_dot,
                circular_pattern_distance(
                    coordinate,
                    line_type_entry(advance_count + lower - 1u).x,
                    period,
                ),
            );
        }
    }
    return StrokePatternSample(drawn, nearest_dot);
}

fn stroke_fragment_visible(input: VertexOutput, world_per_pixel: f32) -> bool {
    if (input.shape_kind < 3u) {
        return true;
    }
    if (material.stroke_values.x < 0.5) {
        return false;
    }
    let pattern = stroke_pattern_sample(input.tex_coord.x, u32(input.tex_coord.y + 0.5));
    let dot_delta_pixels = pattern.dot_delta / world_per_pixel;
    let dot_radius = max(input.stroke_half_width, 0.5);
    let dot_visible = dot_delta_pixels <= dot_radius
        && dot(
            vec2<f32>(dot_delta_pixels / dot_radius, input.shape_coord.y),
            vec2<f32>(dot_delta_pixels / dot_radius, input.shape_coord.y),
        ) <= 1.0;
    if (!pattern.drawn && !dot_visible) {
        return false;
    }
    if (input.shape_kind == 4u) {
        return dot(input.shape_coord, input.shape_coord) <= 1.0 && input.shape_coord.x <= 0.0;
    }
    if (input.shape_kind == 5u) {
        return dot(input.shape_coord, input.shape_coord) <= 1.0 && input.shape_coord.x >= 0.0;
    }
    if (input.shape_kind == 6u) {
        if (dot(input.shape_coord, input.shape_coord) > 1.0) {
            return false;
        }
        let next_direction = input.normal.xy;
        let next_normal = vec2<f32>(-next_direction.y, next_direction.x);
        let covered_by_current = input.shape_coord.x <= 0.0 && abs(input.shape_coord.y) <= 1.0;
        let covered_by_next = dot(input.shape_coord, next_direction) >= 0.0
            && abs(dot(input.shape_coord, next_normal)) <= 1.0;
        return !covered_by_current && !covered_by_next;
    }
    return true;
}

@vertex
fn vertex_main(input: VertexInput) -> VertexOutput {
    let source_style_position = translated_position(input.position);
    let style_position = styled_position(input.position);
    let position = frame_position(style_position);
    var output: VertexOutput;
    output.clip_position = frame.view_projection * vec4<f32>(position, 1.0);
    output.render_position = position;
    output.source_render_position = frame_position(source_style_position);
    output.color = input.color;
    output.proxy_slot = input.proxy_slot;
    output.primitive_slot = input.primitive_slot;
    output.tex_coord = vec2<f32>(0.0, 0.0);
    output.shape_coord = vec2<f32>(0.0, 0.0);
    output.shape_kind = 0u;
    output.style_position = source_style_position;
    output.normal = source_normal_vector(vec3<f32>(0.0, 0.0, 1.0));
    output.stroke_half_width = 0.0;
    return output;
}

@vertex
fn mesh_vertex_main(input: MeshVertexInput) -> VertexOutput {
    let source_style_position = translated_position(input.position);
    let style_position = styled_position(input.position);
    let position = frame_position(style_position);
    var output: VertexOutput;
    output.clip_position = frame.view_projection * vec4<f32>(position, 1.0);
    output.render_position = position;
    output.source_render_position = frame_position(source_style_position);
    output.color = input.color;
    output.proxy_slot = input.proxy_slot;
    output.primitive_slot = input.primitive_slot;
    output.tex_coord = input.tex_coord;
    output.shape_coord = vec2<f32>(0.0, 0.0);
    output.shape_kind = 0u;
    output.style_position = source_style_position;
    output.normal = source_normal_vector(input.normal.xyz);
    output.stroke_half_width = 0.0;
    return output;
}

@vertex
fn instanced_mesh_vertex_main(
    input: MeshVertexInput,
    instance: MeshInstanceInput,
) -> VertexOutput {
    let homogeneous = vec4<f32>(input.position, 1.0);
    let instance_position = vec3<f32>(
        dot(instance.row_0, homogeneous),
        dot(instance.row_1, homogeneous),
        dot(instance.row_2, homogeneous),
    );
    let source_style_position = translated_position(instance_position);
    let style_position = styled_position(instance_position);
    let position = frame_position(style_position);
    var output: VertexOutput;
    output.clip_position = frame.view_projection * vec4<f32>(position, 1.0);
    output.render_position = position;
    output.source_render_position = frame_position(source_style_position);
    output.color = input.color;
    output.proxy_slot = instance.proxy_slot;
    output.primitive_slot = input.primitive_slot + instance.primitive_offset;
    output.tex_coord = input.tex_coord;
    output.shape_coord = vec2<f32>(0.0, 0.0);
    output.shape_kind = 0u;
    output.style_position = source_style_position;
    let homogeneous_normal = vec4<f32>(input.normal.xyz, 0.0);
    output.normal = source_normal_vector(vec3<f32>(
        dot(instance.normal_row_0, homogeneous_normal),
        dot(instance.normal_row_1, homogeneous_normal),
        dot(instance.normal_row_2, homogeneous_normal),
    ));
    output.stroke_half_width = 0.0;
    return output;
}

@vertex
fn native_point_vertex_main(input: PointInstanceInput) -> VertexOutput {
    let source_style_position = translated_position(input.position);
    let style_position = styled_position(input.position);
    let position = frame_position(style_position);
    var output: VertexOutput;
    output.clip_position = frame.view_projection * vec4<f32>(position, 1.0);
    output.render_position = position;
    output.source_render_position = frame_position(source_style_position);
    output.color = point_source_color(input);
    output.proxy_slot = input.proxy_slot;
    output.primitive_slot = input.primitive_slot;
    output.tex_coord = vec2<f32>(0.0, 0.0);
    output.shape_coord = vec2<f32>(0.0, 0.0);
    output.shape_kind = 0u;
    output.style_position = source_style_position;
    output.normal = source_normal_vector(vec3<f32>(0.0, 0.0, 1.0));
    output.stroke_half_width = 0.0;
    return output;
}

@vertex
fn point_vertex_main(input: PointInstanceInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let corner = QUAD_CORNERS[vertex_index];
    let source_style_position = translated_position(input.position);
    let style_position = styled_position(input.position);
    let position = frame_position(style_position);
    let center = frame.view_projection * vec4<f32>(position, 1.0);
    let ndc_offset = corner * input.point_size / frame.viewport_size;
    var output: VertexOutput;
    output.clip_position = center + vec4<f32>(ndc_offset * center.w, 0.0, 0.0);
    output.render_position = position;
    output.source_render_position = frame_position(source_style_position);
    output.color = point_source_color(input);
    output.proxy_slot = input.proxy_slot;
    output.primitive_slot = input.primitive_slot;
    output.tex_coord = vec2<f32>(0.0, 0.0);
    output.shape_coord = corner;
    output.shape_kind = 1u;
    output.style_position = source_style_position;
    output.normal = source_normal_vector(vec3<f32>(0.0, 0.0, 1.0));
    output.stroke_half_width = 0.0;
    return output;
}

@vertex
fn line_vertex_main(input: LineInstanceInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let source_start = translated_position(input.start);
    let source_end = translated_position(input.end);
    let style_start = styled_position(input.start);
    let style_end = styled_position(input.end);
    let style_previous = styled_position(input.previous);
    let style_next = styled_position(input.next);
    let start = frame_position(style_start);
    let end = frame_position(style_end);
    let previous = frame_position(style_previous);
    let next = frame_position(style_next);
    let start_clip = frame.view_projection * vec4<f32>(start, 1.0);
    let end_clip = frame.view_projection * vec4<f32>(end, 1.0);
    let previous_clip = frame.view_projection * vec4<f32>(previous, 1.0);
    let next_clip = frame.view_projection * vec4<f32>(next, 1.0);
    let start_ndc = start_clip.xy / start_clip.w;
    let end_ndc = end_clip.xy / end_clip.w;
    let previous_ndc = previous_clip.xy / previous_clip.w;
    let next_ndc = next_clip.xy / next_clip.w;
    let to_pixels = frame.viewport_size * 0.5;
    let current_direction = safe_pixel_direction((end_ndc - start_ndc) * to_pixels, vec2<f32>(1.0, 0.0));
    var previous_direction = current_direction;
    var next_direction = current_direction;
    let connected_previous = (input.path_meta.y & 1u) != 0u;
    let connected_next = (input.path_meta.y & 2u) != 0u;
    if (connected_previous) {
        previous_direction = safe_pixel_direction((start_ndc - previous_ndc) * to_pixels, current_direction);
    }
    if (connected_next) {
        next_direction = safe_pixel_direction((next_ndc - end_ndc) * to_pixels, current_direction);
    }
    let current_normal = vec2<f32>(-current_direction.y, current_direction.x);
    let previous_normal = vec2<f32>(-previous_direction.y, previous_direction.x);
    let next_normal = vec2<f32>(-next_direction.y, next_direction.x);
    let width = select(input.width, material.stroke_values.y, material.stroke_values.y > 0.0);
    let half_width = width * 0.5;

    var corner = vec2<f32>(0.0);
    var endpoint_clip = start_clip;
    var endpoint_ndc = start_ndc;
    var pixel_offset = vec2<f32>(0.0);
    var along = 0.0;
    var shape_kind = 3u;
    var stroke_aux = vec3<f32>(0.0);
    if (vertex_index < 6u) {
        corner = QUAD_CORNERS[vertex_index];
        along = (corner.x + 1.0) * 0.5;
        endpoint_clip = select(start_clip, end_clip, along > 0.5);
        endpoint_ndc = select(start_ndc, end_ndc, along > 0.5);
        var edge_offset = current_normal * corner.y * half_width;
        if (along < 0.5 && connected_previous && material.stroke_modes.y == 0u) {
            let miter = safe_pixel_direction(previous_normal + current_normal, current_normal);
            let denominator = max(abs(dot(miter, current_normal)), 1.0e-4);
            let scale = 1.0 / denominator;
            if (scale <= material.stroke_values.z) {
                edge_offset = miter * corner.y * half_width * scale;
            }
        }
        if (along > 0.5 && connected_next && material.stroke_modes.y == 0u) {
            let miter = safe_pixel_direction(current_normal + next_normal, current_normal);
            let denominator = max(abs(dot(miter, current_normal)), 1.0e-4);
            let scale = 1.0 / denominator;
            if (scale <= material.stroke_values.z) {
                edge_offset = miter * corner.y * half_width * scale;
            }
        }
        if (along < 0.5 && !connected_previous && material.stroke_modes.x == 1u) {
            edge_offset -= current_direction * half_width;
        }
        if (along > 0.5 && !connected_next && material.stroke_modes.x == 1u) {
            edge_offset += current_direction * half_width;
        }
        pixel_offset = edge_offset;
    } else {
        let at_end = vertex_index >= 12u;
        let decoration_vertex = select(vertex_index - 6u, vertex_index - 12u, at_end);
        corner = QUAD_CORNERS[decoration_vertex];
        along = select(0.0, 1.0, at_end);
        endpoint_clip = select(start_clip, end_clip, at_end);
        endpoint_ndc = select(start_ndc, end_ndc, at_end);
        let round_start_cap = !at_end && !connected_previous && material.stroke_modes.x == 2u;
        let round_end_cap = at_end && !connected_next && material.stroke_modes.x == 2u;
        let round_join = at_end && connected_next && material.stroke_modes.y == 2u;
        if (round_start_cap || round_end_cap || round_join) {
            pixel_offset = (current_direction * corner.x + current_normal * corner.y) * half_width;
            if (round_start_cap) {
                shape_kind = 4u;
            } else if (round_end_cap) {
                shape_kind = 5u;
            } else {
                shape_kind = 6u;
                stroke_aux = vec3<f32>(
                    dot(next_direction, current_direction),
                    dot(next_direction, current_normal),
                    0.0,
                );
            }
        } else if (at_end && connected_next && material.stroke_modes.y != 2u) {
            let miter = safe_pixel_direction(current_normal + next_normal, current_normal);
            let miter_scale = 1.0 / max(abs(dot(miter, current_normal)), 1.0e-4);
            let needs_bevel = material.stroke_modes.y == 1u
                || (material.stroke_modes.y == 0u && miter_scale > material.stroke_values.z);
            if (needs_bevel && decoration_vertex < 3u) {
                let turn = current_direction.x * next_direction.y - current_direction.y * next_direction.x;
                let outer_side = select(1.0, -1.0, turn > 0.0);
                pixel_offset = select(
                    select(current_normal, next_normal, decoration_vertex == 2u)
                        * outer_side * half_width,
                    vec2<f32>(0.0),
                    decoration_vertex == 0u,
                );
            }
        }
    }
    let ndc_offset = pixel_offset * 2.0 / frame.viewport_size;
    var output: VertexOutput;
    output.clip_position = vec4<f32>((endpoint_ndc + ndc_offset) * endpoint_clip.w, endpoint_clip.zw);
    output.render_position = mix(start, end, along);
    output.source_render_position = frame_position(mix(source_start, source_end, along));
    output.color = input.color;
    output.proxy_slot = input.proxy_slot;
    output.primitive_slot = input.primitive_slot;
    output.tex_coord = vec2<f32>(
        input.path_distance.x + along * input.path_distance.y,
        f32(input.path_meta.x),
    );
    output.shape_coord = corner;
    output.shape_kind = shape_kind;
    output.style_position = mix(source_start, source_end, along);
    output.normal = stroke_aux;
    output.stroke_half_width = half_width;
    return output;
}

fn quaternion_rotate(rotation: vec4<f32>, vector: vec3<f32>) -> vec3<f32> {
    let quaternion = rotation / max(length(rotation), 1.0e-7);
    let imaginary = quaternion.xyz;
    return vector
        + 2.0 * cross(imaginary, cross(imaginary, vector) + quaternion.w * vector);
}

fn projected_axis_pixels(center_clip: vec4<f32>, position: vec3<f32>, axis: vec3<f32>) -> vec2<f32> {
    let endpoint_clip = frame.view_projection * vec4<f32>(position + axis, 1.0);
    let center_ndc = center_clip.xy / center_clip.w;
    let endpoint_ndc = endpoint_clip.xy / endpoint_clip.w;
    return (endpoint_ndc - center_ndc) * frame.viewport_size * 0.5;
}

@vertex
fn splat_vertex_main(input: SplatInstanceInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let source_style_position = translated_position(input.position);
    let style_position = styled_position(input.position);
    let position = frame_position(style_position);
    let center = frame.view_projection * vec4<f32>(position, 1.0);
    let axis_x = quaternion_rotate(input.rotation, vec3<f32>(input.scale.x, 0.0, 0.0));
    let axis_y = quaternion_rotate(input.rotation, vec3<f32>(0.0, input.scale.y, 0.0));
    let axis_z = quaternion_rotate(input.rotation, vec3<f32>(0.0, 0.0, input.scale.z));
    let projected_x = projected_axis_pixels(center, position, styled_direction(axis_x));
    let projected_y = projected_axis_pixels(center, position, styled_direction(axis_y));
    let projected_z = projected_axis_pixels(center, position, styled_direction(axis_z));
    let covariance_xx = dot(
        vec3<f32>(projected_x.x, projected_y.x, projected_z.x),
        vec3<f32>(projected_x.x, projected_y.x, projected_z.x),
    ) + 0.25;
    let covariance_xy = dot(
        vec3<f32>(projected_x.x, projected_y.x, projected_z.x),
        vec3<f32>(projected_x.y, projected_y.y, projected_z.y),
    );
    let covariance_yy = dot(
        vec3<f32>(projected_x.y, projected_y.y, projected_z.y),
        vec3<f32>(projected_x.y, projected_y.y, projected_z.y),
    ) + 0.25;
    let trace = covariance_xx + covariance_yy;
    let discriminant = sqrt(max(
        (covariance_xx - covariance_yy) * (covariance_xx - covariance_yy)
            + 4.0 * covariance_xy * covariance_xy,
        0.0,
    ));
    let eigenvalue_1 = max(0.25, 0.5 * (trace + discriminant));
    let eigenvalue_2 = max(0.25, 0.5 * (trace - discriminant));
    var eigenvector_1 = vec2<f32>(1.0, 0.0);
    if (abs(covariance_xy) > 1.0e-6) {
        eigenvector_1 = normalize(vec2<f32>(eigenvalue_1 - covariance_yy, covariance_xy));
    } else if (covariance_yy > covariance_xx) {
        eigenvector_1 = vec2<f32>(0.0, 1.0);
    }
    let eigenvector_2 = vec2<f32>(-eigenvector_1.y, eigenvector_1.x);
    let corner = QUAD_CORNERS[vertex_index] * 3.0;
    let pixel_offset = eigenvector_1 * sqrt(eigenvalue_1) * corner.x
        + eigenvector_2 * sqrt(eigenvalue_2) * corner.y;
    let ndc_offset = pixel_offset * 2.0 / frame.viewport_size;
    var output: VertexOutput;
    output.clip_position = center + vec4<f32>(ndc_offset * center.w, 0.0, 0.0);
    output.render_position = position;
    output.source_render_position = frame_position(source_style_position);
    output.color = input.color;
    output.proxy_slot = input.proxy_slot;
    output.primitive_slot = input.primitive_slot;
    output.tex_coord = vec2<f32>(0.0, 0.0);
    output.shape_coord = corner;
    output.shape_kind = 2u;
    output.style_position = source_style_position;
    output.normal = source_normal_vector(vec3<f32>(0.0, 0.0, 1.0));
    output.stroke_half_width = 0.0;
    return output;
}

@vertex
fn screen_text_vertex_main(input: ScreenTextVertexInput) -> VertexOutput {
    let source_style_position = translated_position(input.anchor);
    let style_position = styled_position(input.anchor);
    let anchor = frame_position(style_position);
    let center = frame.view_projection * vec4<f32>(anchor, 1.0);
    let ndc_offset = input.pixel_offset * 2.0 / frame.viewport_size;
    var output: VertexOutput;
    output.clip_position = center + vec4<f32>(ndc_offset * center.w, 0.0, 0.0);
    output.render_position = anchor;
    output.source_render_position = frame_position(source_style_position);
    output.color = input.color;
    output.proxy_slot = input.proxy_slot;
    output.primitive_slot = input.primitive_slot;
    output.tex_coord = input.tex_coord;
    output.shape_coord = vec2<f32>(0.0, 0.0);
    output.shape_kind = 0u;
    output.style_position = source_style_position;
    output.normal = source_normal_vector(vec3<f32>(0.0, 0.0, 1.0));
    output.stroke_half_width = 0.0;
    return output;
}

fn is_clipped(position: vec3<f32>) -> bool {
    for (var volume_index = 0u; volume_index < frame.clip_volume_count; volume_index++) {
        let metadata = frame.clip_volume_meta[volume_index];
        let first_plane = metadata.x;
        let plane_count = metadata.y;
        let remove_inside = metadata.z == 1u;
        var inside = true;
        for (var local_index = 0u; local_index < plane_count; local_index++) {
            let plane = frame.clip_planes[first_plane + local_index];
            inside = inside && dot(plane.xyz, position) + plane.w >= 0.0;
        }
        if ((!remove_inside && !inside) || (remove_inside && inside)) {
            return true;
        }
    }
    return false;
}

fn presentation_normal(source: vec3<f32>) -> vec3<f32> {
    var normal = source;
    if (length(normal) <= 1.0e-7) {
        normal = vec3<f32>(0.0, 0.0, 1.0);
    }
    return normalize(vec3<f32>(
        normal.xy,
        normal.z / max(material.style_values.y, 1.0e-7),
    ));
}

fn tangent_space_normal(
    geometry_normal: vec3<f32>,
    render_position: vec3<f32>,
    uv: vec2<f32>,
) -> vec3<f32> {
    let map = textureSample(normal_texture, normal_sampler, uv).xyz * 2.0 - vec3<f32>(1.0);
    let position_dx = dpdx(render_position);
    let position_dy = dpdy(render_position);
    let uv_dx = dpdx(uv);
    let uv_dy = dpdy(uv);
    let perpendicular_y = cross(position_dy, geometry_normal);
    let perpendicular_x = cross(geometry_normal, position_dx);
    let tangent = perpendicular_y * uv_dx.x + perpendicular_x * uv_dy.x;
    let bitangent = perpendicular_y * uv_dx.y + perpendicular_x * uv_dy.y;
    let maximum_length = max(dot(tangent, tangent), dot(bitangent, bitangent));
    if (maximum_length <= 1.0e-12 || dot(map, map) <= 1.0e-12) {
        return geometry_normal;
    }
    let inverse_scale = inverseSqrt(maximum_length);
    return normalize(
        tangent * (map.x * inverse_scale)
            + bitangent * (map.y * inverse_scale)
            + geometry_normal * map.z,
    );
}

fn unproject_view_point(ndc: vec2<f32>, depth: f32) -> vec3<f32> {
    let homogeneous = frame.inverse_view_projection * vec4<f32>(ndc, depth, 1.0);
    return homogeneous.xyz / homogeneous.w;
}

fn fragment_view_direction(fragment_position: vec4<f32>) -> vec3<f32> {
    let ndc = vec2<f32>(
        fragment_position.x * 2.0 / frame.viewport_size.x - 1.0,
        1.0 - fragment_position.y * 2.0 / frame.viewport_size.y,
    );
    let near_point = unproject_view_point(ndc, 1.0);
    let farther_point = unproject_view_point(ndc, 0.5);
    return normalize(near_point - farther_point);
}

fn fresnel_schlick(cosine: f32, reflectance: vec3<f32>) -> vec3<f32> {
    let grazing = pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);
    return reflectance + (vec3<f32>(1.0) - reflectance) * grazing;
}

fn geometry_schlick_ggx(n_dot_direction: f32, roughness: f32) -> f32 {
    let radius = roughness + 1.0;
    let k = radius * radius / 8.0;
    return n_dot_direction / max(n_dot_direction * (1.0 - k) + k, 1.0e-6);
}

fn pbr_color(input: VertexOutput, base: vec4<f32>) -> vec4<f32> {
    let texture_flags = material.source_texture_flags.x;
    let normal_uv = source_texture_coordinate(input.tex_coord, 1u);
    var normal = presentation_normal(input.normal);
    if ((texture_flags & 1u) != 0u) {
        normal = tangent_space_normal(normal, input.render_position, normal_uv);
    }
    var metallic = material.source_pbr_values.x;
    var roughness = material.source_pbr_values.y;
    if ((texture_flags & 2u) != 0u) {
        let sampled = textureSample(
            metallic_roughness_texture,
            metallic_roughness_sampler,
            source_texture_coordinate(input.tex_coord, 2u),
        );
        roughness *= sampled.g;
        metallic *= sampled.b;
    }
    metallic = clamp(metallic, 0.0, 1.0);
    roughness = clamp(roughness, 0.045, 1.0);
    var emissive = material.source_emissive.rgb;
    if ((texture_flags & 4u) != 0u) {
        emissive *= textureSample(
            emissive_texture,
            emissive_sampler,
            source_texture_coordinate(input.tex_coord, 3u),
        ).rgb;
    }
    var occlusion = 1.0;
    if ((texture_flags & 8u) != 0u) {
        occlusion = textureSample(
            occlusion_texture,
            occlusion_sampler,
            source_texture_coordinate(input.tex_coord, 4u),
        ).r;
    }

    let view = fragment_view_direction(input.clip_position);
    let light = normalize(vec3<f32>(0.35, -0.45, 0.82));
    let halfway = normalize(view + light);
    let n_dot_light = max(dot(normal, light), 0.0);
    let n_dot_view = max(dot(normal, view), 0.0);
    let n_dot_halfway = max(dot(normal, halfway), 0.0);
    let halfway_dot_view = max(dot(halfway, view), 0.0);
    let alpha = roughness * roughness;
    let alpha_squared = alpha * alpha;
    let denominator = n_dot_halfway * n_dot_halfway * (alpha_squared - 1.0) + 1.0;
    let distribution = alpha_squared / max(3.14159265 * denominator * denominator, 1.0e-6);
    let geometry = geometry_schlick_ggx(n_dot_view, roughness)
        * geometry_schlick_ggx(n_dot_light, roughness);
    let base_reflectance = mix(vec3<f32>(0.04), base.rgb, metallic);
    let fresnel = fresnel_schlick(halfway_dot_view, base_reflectance);
    let specular = distribution * geometry * fresnel
        / max(4.0 * n_dot_view * n_dot_light, 1.0e-6);
    let diffuse_weight = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic);
    let direct = (diffuse_weight * base.rgb / 3.14159265 + specular)
        * vec3<f32>(2.2)
        * n_dot_light;
    let ambient = base.rgb * (0.18 * occlusion);
    return vec4<f32>(ambient + direct + emissive, base.a);
}

fn resolved_fragment_color(input: VertexOutput, stroke_world_per_pixel: f32) -> vec4<f32> {
    if ((input.shape_kind < 3u && material.style_values.w < 0.5)
        || !stroke_fragment_visible(input, stroke_world_per_pixel)) {
        discard;
    }
    if (is_clipped(input.source_render_position)) {
        discard;
    }
    if (input.shape_kind == 1u && dot(input.shape_coord, input.shape_coord) > 1.0) {
        discard;
    }
    let base_uv = source_texture_coordinate(input.tex_coord, 0u);
    var color = styled_color(input.color, input.style_position.z, input.shape_kind)
        * textureSample(base_color_texture, base_color_sampler, base_uv);
    if (material.source_pbr_values.z > 0.5 && material.color_mode == 0u) {
        color = pbr_color(input, color);
    }
    color = apply_hatch(color, input.style_position);
    if (input.shape_kind == 2u) {
        color.a *= exp(-0.5 * dot(input.shape_coord, input.shape_coord));
        if (color.a < 0.0039215686) {
            discard;
        }
    }
    if (material.alpha_mode == 1u && color.a < material.alpha_cutoff) {
        discard;
    }
    return color;
}

@fragment
fn color_fragment(input: VertexOutput) -> @location(0) vec4<f32> {
    let stroke_world_per_pixel = max(fwidth(input.tex_coord.x), 1.0e-12);
    return resolved_fragment_color(input, stroke_world_per_pixel);
}

struct OitOutput {
    @location(0) accumulation: vec4<f32>,
    @location(1) revealage: vec4<f32>,
}

@fragment
fn oit_fragment(input: VertexOutput) -> OitOutput {
    let stroke_world_per_pixel = max(fwidth(input.tex_coord.x), 1.0e-12);
    let color = resolved_fragment_color(input, stroke_world_per_pixel);
    let alpha = clamp(color.a, 0.0, 1.0);
    // Reverse-Z maps near fragments to one and far fragments to zero. Keep the
    // contribution bounded so dense overlap stays representable in Rgba16Float.
    let alpha_weight = pow(alpha + 0.01, 3.0) * 4.0;
    let depth_weight = pow(0.1 + input.clip_position.z * 0.9, 3.0);
    let weight = clamp(alpha_weight * depth_weight, 0.01, 4.0);
    var output: OitOutput;
    output.accumulation = vec4<f32>(color.rgb * alpha, alpha) * weight;
    output.revealage = vec4<f32>(alpha, alpha, alpha, alpha);
    return output;
}

struct PickOutput {
    @location(0) proxy: vec4<u32>,
    @location(1) primitive: vec4<u32>,
    @location(2) depth: vec4<u32>,
}

fn rgba8(value: u32) -> vec4<u32> {
    return vec4<u32>(
        value & 255u,
        (value >> 8u) & 255u,
        (value >> 16u) & 255u,
        (value >> 24u) & 255u,
    );
}

@fragment
fn pick_fragment(input: VertexOutput) -> PickOutput {
    let stroke_world_per_pixel = max(fwidth(input.tex_coord.x), 1.0e-12);
    if ((input.shape_kind < 3u && material.style_values.w < 0.5)
        || !stroke_fragment_visible(input, stroke_world_per_pixel)) {
        discard;
    }
    if (is_clipped(input.source_render_position)) {
        discard;
    }
    if (input.shape_kind == 1u && dot(input.shape_coord, input.shape_coord) > 1.0) {
        discard;
    }
    let pick_color = styled_color(input.color, input.style_position.z, input.shape_kind)
        * textureSample(
            base_color_texture,
            base_color_sampler,
            source_texture_coordinate(input.tex_coord, 0u),
        );
    if ((material.alpha_mode == 1u && pick_color.a < material.alpha_cutoff)
        || pick_color.a <= 0.0) {
        discard;
    }
    if (input.shape_kind == 2u
        && pick_color.a * exp(-0.5 * dot(input.shape_coord, input.shape_coord)) < 0.0039215686) {
        discard;
    }
    var output: PickOutput;
    output.proxy = rgba8(input.proxy_slot);
    output.primitive = rgba8(input.primitive_slot);
    output.depth = rgba8(bitcast<u32>(input.clip_position.z));
    return output;
}
