//! Exact, fixed-topology geometry for a chord's extruded quadrilateral.
use rapier3d::parry::{
    bounding_volume::{Aabb, BoundingSphere},
    mass_properties::MassProperties,
    math::{Pose, Vector},
    query::{
        PointProjection, PointQuery, Ray, RayCast, RayIntersection,
        details::local_ray_intersection_with_support_map_with_params, gjk::VoronoiSimplex,
    },
    shape::{
        FeatureId, PackedFeatureId, PolygonalFeature, PolygonalFeatureMap, Shape, ShapeType,
        SupportMap, TypedShape,
    },
};

const FACES: [[usize; 4]; 6] = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [3, 2, 6, 7],
    [0, 3, 7, 4],
    [1, 5, 6, 2],
];
const FACE_EDGES: [[u32; 4]; 6] = [
    [0, 1, 2, 3],
    [7, 6, 5, 4],
    [8, 4, 9, 0],
    [2, 10, 6, 11],
    [3, 11, 7, 8],
    [9, 5, 10, 1],
];
const VERTEX_FACES: [[usize; 3]; 8] = [
    [0, 2, 4],
    [0, 2, 5],
    [0, 3, 5],
    [0, 3, 4],
    [1, 2, 4],
    [1, 2, 5],
    [1, 3, 5],
    [1, 3, 4],
];

#[derive(Clone, Copy, Debug)]
pub(crate) struct ChordPrism {
    points: [Vector; 8],
    normals: [Vector; 6],
    aabb: Aabb,
    reversed: bool,
}

impl ChordPrism {
    pub(crate) fn new(points: [Vector; 8], winding: f32) -> Self {
        let normals = FACES.map(|face| {
            (points[face[1]] - points[face[0]])
                .cross(points[face[2]] - points[face[0]])
                .normalize()
                * winding
        });
        let low = points
            .into_iter()
            .fold(Vector::splat(f32::INFINITY), Vector::min);
        let high = points
            .into_iter()
            .fold(Vector::splat(f32::NEG_INFINITY), Vector::max);
        Self {
            points,
            normals,
            aabb: Aabb::new(low, high),
            reversed: winding < 0.0,
        }
    }
    pub(crate) fn points(&self) -> &[Vector; 8] {
        &self.points
    }
    fn face(&self, index: usize) -> [usize; 4] {
        let [a, b, c, d] = FACES[index];
        if self.reversed {
            [a, d, c, b]
        } else {
            [a, b, c, d]
        }
    }
    fn projection(&self, point: Vector, solid: bool) -> (PointProjection, FeatureId) {
        let p = Vector::new(point.x, point.y, 0.0);
        let mut nearest = Vector::ZERO;
        let mut distance = f32::INFINITY;
        let mut edge_id = 0;
        let mut fraction = 0.0;
        let (mut positive, mut negative) = (false, false);
        for edge in 0..4 {
            let v = self.points[edge];
            let w = self.points[(edge + 1) % 4];
            let a = Vector::new(v.x, v.y, 0.0);
            let delta = Vector::new(w.x - v.x, w.y - v.y, 0.0);
            let offset = p - a;
            let cross = delta.x * offset.y - delta.y * offset.x;
            positive |= cross > 0.0;
            negative |= cross < 0.0;
            let t = (offset.dot(delta) / delta.length_squared()).clamp(0.0, 1.0);
            let candidate = a + delta * t;
            let squared = (p - candidate).length_squared();
            if squared < distance {
                distance = squared;
                nearest = candidate;
                edge_id = edge;
                fraction = t;
            }
        }
        let inside_xy = !(positive && negative);
        let front = self.points[0].z;
        let back = self.points[4].z;
        let inside_z = (front.min(back)..=front.max(back)).contains(&point.z);
        let inside = inside_xy && inside_z;
        if inside && solid {
            return (PointProjection::new(true, point), FeatureId::Unknown);
        }
        let mut xy_boundary = !inside_xy || distance == 0.0;
        let mut xy = if inside_xy { p } else { nearest };
        let mut z = point.z.clamp(front.min(back), front.max(back));
        if inside {
            let plane = if (point.z - front).abs() <= (point.z - back).abs() {
                front
            } else {
                back
            };
            if distance <= (point.z - plane).powi(2) {
                xy = nearest;
                xy_boundary = true;
            } else {
                z = plane;
            }
        }
        let end = if z == front {
            Some(0)
        } else if z == back {
            Some(1)
        } else {
            None
        };
        let vertex = if fraction == 0.0 {
            Some(edge_id)
        } else if fraction == 1.0 {
            Some((edge_id + 1) % 4)
        } else {
            None
        };
        let feature = if xy_boundary {
            match (vertex, end) {
                (Some(v), Some(e)) => FeatureId::Vertex((v + e * 4) as u32),
                (Some(v), None) => FeatureId::Edge((8 + v) as u32),
                (None, Some(e)) => FeatureId::Edge((edge_id + e * 4) as u32),
                (None, None) => FeatureId::Face([2, 5, 3, 4][edge_id]),
            }
        } else {
            FeatureId::Face(end.expect("projection reaches a boundary") as u32)
        };
        (
            PointProjection::new(inside, Vector::new(xy.x, xy.y, z)),
            feature,
        )
    }
}

impl SupportMap for ChordPrism {
    fn local_support_point(&self, dir: Vector) -> Vector {
        let mut index = 0;
        for i in 1..4 {
            if self.points[i].x * dir.x + self.points[i].y * dir.y
                > self.points[index].x * dir.x + self.points[index].y * dir.y
            {
                index = i;
            }
        }
        if (self.points[4].z - self.points[0].z) * dir.z > 0.0 {
            index += 4;
        }
        self.points[index]
    }
}
impl PolygonalFeatureMap for ChordPrism {
    fn local_support_feature(&self, dir: Vector, out: &mut PolygonalFeature) {
        let mut face = 0;
        for i in 1..6 {
            if self.normals[i].dot(dir) > self.normals[face].dot(dir) {
                face = i;
            }
        }
        let ids = self.face(face);
        let edges = FACE_EDGES[face];
        *out = PolygonalFeature {
            vertices: ids.map(|i| self.points[i]),
            vids: ids.map(|i| PackedFeatureId::vertex(i as u32)),
            eids: (if self.reversed {
                [edges[3], edges[2], edges[1], edges[0]]
            } else {
                edges
            })
            .map(PackedFeatureId::edge),
            fid: PackedFeatureId::face(face as u32),
            num_vertices: 4,
        };
    }
    fn is_convex_polyhedron(&self) -> bool {
        true
    }
}
impl PointQuery for ChordPrism {
    fn project_local_point(&self, point: Vector, solid: bool) -> PointProjection {
        self.projection(point, solid).0
    }
    fn project_local_point_and_get_feature(&self, point: Vector) -> (PointProjection, FeatureId) {
        self.projection(point, false)
    }
}
impl RayCast for ChordPrism {
    fn cast_local_ray_and_get_normal(
        &self,
        ray: &Ray,
        limit: f32,
        solid: bool,
    ) -> Option<RayIntersection> {
        local_ray_intersection_with_support_map_with_params(
            self,
            &mut VoronoiSimplex::new(),
            ray,
            limit,
            solid,
        )
    }
}
impl Shape for ChordPrism {
    fn clone_dyn(&self) -> Box<dyn Shape> {
        Box::new(*self)
    }
    fn scale_dyn(&self, scale: Vector, _: u32) -> Option<Box<dyn Shape>> {
        if !scale.is_finite() || scale.abs().min_element() == 0.0 {
            return None;
        }
        let winding = if self.reversed { -1.0 } else { 1.0 }
            * scale.x.signum()
            * scale.y.signum()
            * scale.z.signum();
        Some(Box::new(Self::new(self.points.map(|p| p * scale), winding)))
    }
    fn compute_local_aabb(&self) -> Aabb {
        self.aabb
    }
    fn compute_aabb(&self, pose: &Pose) -> Aabb {
        let points = self.points.map(|p| pose * p);
        Aabb::new(
            points
                .into_iter()
                .fold(Vector::splat(f32::INFINITY), Vector::min),
            points
                .into_iter()
                .fold(Vector::splat(f32::NEG_INFINITY), Vector::max),
        )
    }
    fn compute_local_bounding_sphere(&self) -> BoundingSphere {
        let centre = self.aabb.center();
        BoundingSphere::new(
            centre,
            self.points
                .into_iter()
                .map(|p| (p - centre).length())
                .fold(0.0_f32, f32::max),
        )
    }
    fn mass_properties(&self, density: f32) -> MassProperties {
        let triangles: [[u32; 3]; 12] = std::array::from_fn(|i| {
            let f = self.face(i / 2);
            let tri = if i % 2 == 0 {
                [f[0], f[1], f[2]]
            } else {
                [f[0], f[2], f[3]]
            };
            tri.map(|v| v as u32)
        });
        MassProperties::from_convex_polyhedron(density, &self.points, &triangles)
    }
    fn is_convex(&self) -> bool {
        true
    }
    fn shape_type(&self) -> ShapeType {
        ShapeType::Custom
    }
    fn as_typed_shape(&self) -> TypedShape<'_> {
        TypedShape::Custom(self)
    }
    fn ccd_thickness(&self) -> f32 {
        self.aabb.half_extents().min_element()
    }
    fn ccd_angular_thickness(&self) -> f32 {
        core::f32::consts::FRAC_PI_4
    }
    fn as_support_map(&self) -> Option<&dyn SupportMap> {
        Some(self)
    }
    fn as_polygonal_feature_map(&self) -> Option<(&dyn PolygonalFeatureMap, f32)> {
        Some((self, 0.0))
    }
    fn feature_normal_at_point(&self, feature: FeatureId, _: Vector) -> Option<Vector> {
        match feature {
            FeatureId::Face(i) => self.normals.get(i as usize).copied(),
            FeatureId::Vertex(i) => VERTEX_FACES.get(i as usize).map(|faces| {
                faces
                    .iter()
                    .map(|&f| self.normals[f])
                    .sum::<Vector>()
                    .normalize()
            }),
            FeatureId::Edge(i) => {
                let mut normal = Vector::ZERO;
                let mut found = false;
                for (face, edges) in FACE_EDGES.iter().enumerate() {
                    if edges.contains(&i) {
                        normal += self.normals[face];
                        found = true;
                    }
                }
                found.then(|| normal.normalize())
            }
            FeatureId::Unknown => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rapier3d::parry::shape::{ConvexPolyhedron, Triangle};

    fn fixture(delta: f32, end: usize) -> (ChordPrism, ConvexPolyhedron, [[u32; 3]; 12]) {
        let segment = crate::surface_segment(0.0, 0.2, 0.2 + delta, end, 2.596923, 0.4, 0.00625);
        let shared = segment.shape();
        let prism = *shared.as_shape::<ChordPrism>().unwrap();
        // Independent triangle inventory from the original closed prism.
        let mut triangles = [
            [0, 1, 2],
            [0, 2, 3],
            [4, 6, 5],
            [4, 7, 6],
            [0, 4, 5],
            [0, 5, 1],
            [3, 2, 6],
            [3, 6, 7],
            [0, 3, 7],
            [0, 7, 4],
            [1, 5, 6],
            [1, 6, 2],
        ];
        if end == 1 {
            for triangle in &mut triangles {
                triangle.swap(1, 2);
            }
        }
        let reference =
            ConvexPolyhedron::from_convex_mesh(prism.points.to_vec(), &triangles).unwrap();
        (prism, reference, triangles)
    }

    #[test]
    fn projection_matches_independent_triangle_surface_distances() {
        for delta in [-0.12, -0.015, 0.0, 0.025, 0.12] {
            for end in 0..2 {
                let (prism, reference, triangles) = fixture(delta, end);
                let centre = prism.aabb.center();
                let extents = prism.aabb.half_extents();
                for x in -3..=3 {
                    for y in -3..=3 {
                        for z in -3..=3 {
                            let p = centre
                                + extents
                                    * Vector::new(
                                        x as f32 * 0.47,
                                        y as f32 * 0.43,
                                        z as f32 * 0.41,
                                    );
                            let actual = prism.project_local_point(p, false);
                            let distance = triangles
                                .iter()
                                .map(|t| {
                                    let triangle = Triangle::new(
                                        prism.points[t[0] as usize],
                                        prism.points[t[1] as usize],
                                        prism.points[t[2] as usize],
                                    );
                                    (p - triangle.project_local_point(p, false).point).length()
                                })
                                .fold(f32::INFINITY, f32::min);
                            assert!(
                                ((p - actual.point).length() - distance).abs() < 0.00002,
                                "delta={delta}, end={end}, p={p:?}, projection={actual:?}, expected distance={distance}"
                            );
                            let inside = reference.faces().iter().all(|face| {
                                let first = reference.vertices_adj_to_face()
                                    [face.first_vertex_or_edge as usize]
                                    as usize;
                                (p - reference.points()[first]).dot(face.normal) <= 0.0
                            });
                            assert_eq!(
                                actual.is_inside, inside,
                                "delta={delta}, end={end}, p={p:?}"
                            );
                            if inside {
                                assert_eq!(prism.project_local_point(p, true).point, p);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn bounds_mass_faces_and_rays_match_closed_convex_reference() {
        for delta in [-0.12, 0.0, 0.12] {
            for end in 0..2 {
                let (prism, reference, _) = fixture(delta, end);
                let pose = Pose::new(Vector::new(0.2, 0.4, -0.1), Vector::new(0.1, -0.2, 0.7));
                let actual = prism.compute_aabb(&pose);
                let expected = reference.compute_aabb(&pose);
                assert!((actual.mins - expected.mins).length() < 0.000005);
                assert!((actual.maxs - expected.maxs).length() < 0.000005);
                let mass = prism.mass_properties(2.0);
                let expected = reference.mass_properties(2.0);
                assert!((mass.mass() - expected.mass()).abs() < 0.000002);
                assert!((mass.local_com - expected.local_com).length() < 0.00001);
                assert!(
                    (mass.principal_inertia().length() - expected.principal_inertia().length())
                        .abs()
                        < 0.000002
                );
                for dir in [
                    Vector::X,
                    -Vector::X,
                    Vector::Y,
                    -Vector::Y,
                    Vector::Z,
                    -Vector::Z,
                ] {
                    let actual = prism.local_support_point(dir).dot(dir);
                    let expected = reference.local_support_point(dir).dot(dir);
                    assert!((actual - expected).abs() < 0.000002);
                    let sphere = prism.compute_local_bounding_sphere();
                    let ray = Ray::new(sphere.center + dir * sphere.radius * 2.0, -dir);
                    let actual = prism
                        .cast_local_ray_and_get_normal(&ray, 100.0, false)
                        .unwrap();
                    let expected = reference
                        .cast_local_ray_and_get_normal(&ray, 100.0, false)
                        .unwrap();
                    assert!((actual.time_of_impact - expected.time_of_impact).abs() < 0.00002);
                }
                for dir in prism.normals {
                    let mut actual = PolygonalFeature::default();
                    let mut expected = PolygonalFeature::default();
                    prism.local_support_feature(dir, &mut actual);
                    reference.local_support_feature(dir, &mut expected);
                    assert_eq!(actual.num_vertices, 4);
                    assert_eq!(expected.num_vertices, 4);
                    for point in actual.vertices {
                        assert!(expected.vertices.contains(&point));
                    }
                }
                let scale = Vector::new(-1.2, 0.7, -0.8);
                let scaled = prism.scale_dyn(scale, 0).unwrap();
                assert!(
                    (scaled.mass_properties(2.0).mass()
                        - mass.mass() * (scale.x * scale.y * scale.z).abs())
                    .abs()
                        < 0.000003
                );
                assert!(prism.scale_dyn(Vector::new(0.0, 1.0, 1.0), 0).is_none());
            }
        }
    }
}
