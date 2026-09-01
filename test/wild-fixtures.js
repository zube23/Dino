'use strict';

/*
 * Realistic "wild" DXF fixtures imitating what various CAD programs and
 * converters actually export - full headers, junk entities, xdata, blocks,
 * hatches, odd units, subclass markers... Each fixture declares the expected
 * tight bounding box of the imported part.
 */

function j(lines) {
  return lines.join('\r\n');
}

const fixtures = [];

// ---------------------------------------------------------------------------
// W1: AutoCAD R12 with full header, dimension + text junk and XDATA
// L-plate at offset (1000,500) with a bulged right edge (bulge 0.2 over a
// 60mm chord adds a 6mm sagitta: 180 + 6 = 186 wide) and a circle hole.
fixtures.push({
  name: 'acad_r12_full',
  expect: { w: 186, h: 120, tol: 0.6 },
  content: j([
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$EXTMIN', '10', '1000', '20', '500', '30', '0',
    '9', '$EXTMAX', '10', '1180', '20', '620', '30', '0',
    '9', '$LIMMIN', '10', '0', '20', '0',
    '9', '$LIMMAX', '10', '420', '20', '297',
    '9', '$LTSCALE', '40', '1',
    '9', '$DIMSCALE', '40', '1',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'KOTE', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    // main contour with xdata appended
    '0', 'POLYLINE', '8', '0', '66', '1', '70', '1', '10', '0', '20', '0', '30', '0',
    '0', 'VERTEX', '8', '0', '10', '1000', '20', '500', '30', '0',
    '0', 'VERTEX', '8', '0', '10', '1180', '20', '500', '30', '0', '42', '0.2',
    '0', 'VERTEX', '8', '0', '10', '1180', '20', '560', '30', '0',
    '0', 'VERTEX', '8', '0', '10', '1060', '20', '560', '30', '0',
    '0', 'VERTEX', '8', '0', '10', '1060', '20', '620', '30', '0',
    '0', 'VERTEX', '8', '0', '10', '1000', '20', '620', '30', '0',
    '0', 'SEQEND', '8', '0',
    '0', 'CIRCLE', '8', '0', '62', '256', '39', '0', '210', '0', '220', '0', '230', '1',
    '10', '1030', '20', '530', '40', '8',
    '1001', 'ACAD', '1000', 'proizvod 4711', '1010', '99999', '1020', '99999', '1030', '0',
    // annotation junk that must NOT affect the part
    '0', 'TEXT', '8', 'KOTE', '10', '2500', '20', '2500', '40', '25', '1', 'NACRT BR. 42',
    '0', 'DIMENSION', '8', 'KOTE', '2', '*D1', '10', '3000', '20', '3000', '70', '0', '1', '',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W2: SolidWorks-style flat pattern: rounded rectangle 200 x 100 (r10) from
// LINE + ARC entities, bend lines on their own layer, one degenerate line.
fixtures.push({
  name: 'solidworks_flat',
  expect: { w: 200, h: 100, tol: 0.2 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '10', '20', '0', '11', '190', '21', '0',
    '0', 'ARC', '8', '0', '10', '190', '20', '10', '40', '10', '50', '270', '51', '0',
    '0', 'LINE', '8', '0', '10', '200', '20', '10', '11', '200', '21', '90',
    '0', 'ARC', '8', '0', '10', '190', '20', '90', '40', '10', '50', '0', '51', '90',
    '0', 'LINE', '8', '0', '10', '190', '20', '100', '11', '10', '21', '100',
    '0', 'ARC', '8', '0', '10', '10', '20', '90', '40', '10', '50', '90', '51', '180',
    '0', 'LINE', '8', '0', '10', '0', '20', '90', '11', '0', '21', '10',
    '0', 'ARC', '8', '0', '10', '10', '20', '10', '40', '10', '50', '180', '51', '270',
    '0', 'LINE', '8', 'BEND', '10', '60', '20', '0', '11', '60', '21', '100',
    '0', 'LINE', '8', 'BEND', '10', '140', '20', '0', '11', '140', '21', '100',
    '0', 'LINE', '8', '0', '10', '50', '20', '50', '11', '50', '21', '50',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W3: QCAD/dxflib AC1015 with CLASSES + OBJECTS sections and subclass
// markers; LWPOLYLINE plate 150 x 90 with a circle hole.
fixtures.push({
  name: 'qcad_2000',
  expect: { w: 150, h: 90, tol: 0.2 },
  content: j([
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1015',
    '9', '$HANDSEED', '5', 'FFFF',
    '9', '$INSUNITS', '70', '4',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'CLASSES',
    '0', 'CLASS', '1', 'ACDBDICTIONARYWDFLT', '2', 'AcDbDictionaryWithDefault', '90', '0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '5', 'A1', '100', 'AcDbEntity', '8', '0', '62', '256', '370', '-1',
    '100', 'AcDbPolyline', '90', '4', '70', '1', '43', '0',
    '10', '0', '20', '0',
    '10', '150', '20', '0',
    '10', '150', '20', '90',
    '10', '0', '20', '90',
    '0', 'CIRCLE', '5', 'A2', '100', 'AcDbEntity', '8', '0', '100', 'AcDbCircle',
    '10', '75', '20', '45', '40', '10',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'OBJECTS',
    '0', 'DICTIONARY', '5', 'C0', '3', 'ACAD_GROUP', '350', 'C1',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W4: plate drawn in INCHES (4 x 2 in) - must convert to 101.6 x 50.8 mm
fixtures.push({
  name: 'inches_plate',
  expect: { w: 101.6, h: 50.8, tol: 0.05 },
  content: j([
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1015',
    '9', '$INSUNITS', '70', '1',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0',
    '10', '4', '20', '0',
    '10', '4', '20', '2',
    '10', '0', '20', '2',
    '0', 'CIRCLE', '8', '0', '10', '2', '20', '1', '40', '0.25',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W5: everything lives in *Model_Space (ENTITIES empty); *Paper_Space holds
// a big layout frame that must be ignored. Part 100 x 60.
fixtures.push({
  name: 'modelspace_blocks',
  expect: { w: 100, h: 60, tol: 0.2 },
  content: j([
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '0', '2', '*Model_Space', '70', '0', '10', '0', '20', '0', '30', '0', '3', '*Model_Space',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '60', '10', '0', '20', '60',
    '0', 'CIRCLE', '8', '0', '10', '20', '20', '20', '40', '6',
    '0', 'ENDBLK', '8', '0',
    '0', 'BLOCK', '8', '0', '2', '*Paper_Space', '70', '0', '10', '0', '20', '0', '30', '0', '3', '*Paper_Space',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '1000', '20', '0', '10', '1000', '20', '700', '10', '0', '20', '700',
    '0', 'ENDBLK', '8', '0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W6: converter output where the cut contour exists ONLY as a HATCH:
// polyline loop 120 x 80 (rounded via bulge) + circular hole from two arc
// edges; seed points after the loops must not be consumed as geometry.
fixtures.push({
  name: 'hatch_only',
  expect: { w: 120, h: 80, tol: 0.3 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'HATCH', '5', 'H1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbHatch',
    '10', '0', '20', '0', '30', '0', '210', '0', '220', '0', '230', '1',
    '2', 'SOLID', '70', '1', '71', '0',
    '91', '2',
    // loop 1: polyline boundary 120 x 80
    '92', '7', '72', '1', '73', '1', '93', '4',
    '10', '0', '20', '0', '42', '0',
    '10', '120', '20', '0', '42', '0',
    '10', '120', '20', '80', '42', '0',
    '10', '0', '20', '80', '42', '0',
    // loop 2: circle hole r=15 at (60,40) from two arc edges
    '92', '5', '93', '2',
    '72', '2', '10', '60', '20', '40', '40', '15', '50', '0', '51', '180', '73', '1',
    '72', '2', '10', '60', '20', '40', '40', '15', '50', '180', '51', '360', '73', '1',
    '75', '1', '76', '1',
    '98', '1', '10', '99999', '20', '99999',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W7: PDF-converter style - hundreds of tiny LINE segments, drawing far from
// the origin, mixed junk spacing. Rect 90 x 45 with a segment-circle hole.
fixtures.push({
  name: 'segment_soup_far_origin',
  expect: { w: 90, h: 45, tol: 0.3 },
  content: (() => {
    const L = ['0', 'SECTION', '2', 'ENTITIES'];
    const X = 250000;
    const Y = 180000;
    const rect = [[0, 0], [90, 0], [90, 45], [0, 45]];
    for (let s = 0; s < 4; s++) {
      const [x1, y1] = rect[s];
      const [x2, y2] = rect[(s + 1) % 4];
      for (let k = 0; k < 25; k++) {
        const t1 = k / 25;
        const t2 = (k + 1) / 25;
        L.push('0', 'LINE', ' 8', '0',
          '10', String(X + x1 + (x2 - x1) * t1), '20', String(Y + y1 + (y2 - y1) * t1),
          '11', String(X + x1 + (x2 - x1) * t2), '21', String(Y + y1 + (y2 - y1) * t2));
      }
    }
    for (let k = 0; k < 60; k++) {
      const a1 = (k / 60) * Math.PI * 2;
      const a2 = ((k + 1) / 60) * Math.PI * 2;
      L.push('0', 'LINE', '8', '0',
        '10', String(X + 45 + 12 * Math.cos(a1)), '20', String(Y + 22.5 + 12 * Math.sin(a1)),
        '11', String(X + 45 + 12 * Math.cos(a2)), '21', String(Y + 22.5 + 12 * Math.sin(a2)));
    }
    L.push('0', 'ENDSEC', '0', 'EOF');
    return L.join('\n');
  })(),
});

// ---------------------------------------------------------------------------
// W8: SPLINE with only fit points (no knot vector) - oval blob ~100 wide
fixtures.push({
  name: 'spline_fit_only',
  expect: { w: 100, h: 50, tol: 8 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'SPLINE', '8', '0', '70', '11', '71', '3', '74', '8',
    '11', '0', '21', '25',
    '11', '50', '21', '50',
    '11', '100', '21', '25',
    '11', '50', '21', '0',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W9: 3D POLYLINE (flag 8) with Z values - flattened to 2D, 80 x 40
fixtures.push({
  name: 'polyline_3d_flatten',
  expect: { w: 80, h: 40, tol: 0.2 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'POLYLINE', '8', '0', '66', '1', '70', '9', '10', '0', '20', '0', '30', '0',
    '0', 'VERTEX', '8', '0', '10', '0', '20', '0', '30', '5', '70', '32',
    '0', 'VERTEX', '8', '0', '10', '80', '20', '0', '30', '5', '70', '32',
    '0', 'VERTEX', '8', '0', '10', '80', '20', '40', '30', '5', '70', '32',
    '0', 'VERTEX', '8', '0', '10', '0', '20', '40', '30', '5', '70', '32',
    '0', 'SEQEND', '8', '0',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W10: drawing with a title frame around the part - the frame IS imported
// (impossible to distinguish from a rectangular part reliably); this fixture
// documents that behavior: bbox is the frame, and the part must still be
// inside the imported geometry.
fixtures.push({
  name: 'title_frame',
  expect: { w: 297, h: 210, tol: 0.3 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', 'OKVIR', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '297', '20', '0', '10', '297', '20', '210', '10', '0', '20', '210',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '80', '20', '60', '10', '180', '20', '60', '10', '180', '20', '120', '10', '80', '20', '120',
    '0', 'TEXT', '8', 'OKVIR', '10', '200', '20', '10', '40', '8', '1', 'PLOCICA 100x60',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W11: scientific notation and negative coordinates - rect 150 x 75
fixtures.push({
  name: 'scientific_notation',
  expect: { w: 150, h: 75, tol: 0.2 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '-1.5e+02', '20', '-5.0E+01', '11', '0.0e+00', '21', '-5.0E+01',
    '0', 'LINE', '8', '0', '10', '0.0e+00', '20', '-5.0E+01', '11', '0', '21', '2.5E1',
    '0', 'LINE', '8', '0', '10', '0', '20', '2.5E1', '11', '-1.5e+02', '21', '25',
    '0', 'LINE', '8', '0', '10', '-1.5e+02', '20', '25', '11', '-150', '21', '-50',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W12: full ELLIPSE (120 x 60) plus a partial elliptical arc inside
fixtures.push({
  name: 'ellipse_ring',
  expect: { w: 120, h: 60, tol: 0.3 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '11', '60', '21', '0',
    '40', '0.5', '41', '0', '42', '6.283185307179586',
    '0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '11', '30', '21', '0',
    '40', '0.6', '41', '0.5', '42', '2.6',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

// ---------------------------------------------------------------------------
// W13: malformed-ish file: stray VERTEX/SEQEND outside a POLYLINE and an
// unknown entity type - importer must survive and read the 70 x 30 rect.
fixtures.push({
  name: 'stray_vertex_junk',
  expect: { w: 70, h: 30, tol: 0.2 },
  content: j([
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'VERTEX', '8', '0', '10', '5000', '20', '5000',
    '0', 'SEQEND', '8', '0',
    '0', 'WEIRDTHING', '8', '0', '10', '1', '20', '2',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '70', '20', '0', '10', '70', '20', '30', '10', '0', '20', '30',
    '0', 'ENDSEC',
    '0', 'EOF',
  ]),
});

module.exports = { fixtures };
