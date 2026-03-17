export interface SplinePoint {
  time: number;
  value: number;
}

/**
 * Monotone Cubic Spline interpolation.
 * Implements the Fritsch-Carlson method to preserve monotonicity of the dataset
 * and prevent "overshoot" artifacts common in standard cubic splines.
 */
export class MonotoneCubicSpline {
  private xs: number[];
  private ys: number[];
  private m: number[]; // Tangents

  /**
   * @param points Array of time/value points. MUST be sorted by time.
   */
  constructor(points: SplinePoint[]) {
    // 1. Unpack and strictly sort (just in case, though we expect sorted input)
    const sorted = [...points].sort((a, b) => a.time - b.time);
    
    // De-duplicate times (keep last)
    const unique: SplinePoint[] = [];
    if (sorted.length > 0) {
        unique.push(sorted[0]);
        for (let i = 1; i < sorted.length; i++) {
            if (Math.abs(sorted[i].time - sorted[i-1].time) > 0.000001) {
                unique.push(sorted[i]);
            }
        }
    }

    this.xs = unique.map(p => p.time);
    this.ys = unique.map(p => p.value);
    
    const n = this.xs.length;
    this.m = new Array(n).fill(0);

    if (n > 1) {
      this.calculateTangents(n);
      this.calculateAreas();
    }
  }

  private calculateTangents(n: number) {
    const dxs = [];
    const dys = [];
    const secants = [];

    // Calculate secants
    for (let i = 0; i < n - 1; i++) {
      const dx = this.xs[i + 1] - this.xs[i];
      const dy = this.ys[i + 1] - this.ys[i];
      dxs.push(dx);
      dys.push(dy);
      secants.push(dy / dx);
    }

    // Initialize tangents (m)
    const ms = this.m;

    // Boundaries: simple usage of secant
    ms[0] = secants[0];
    ms[n - 1] = secants[n - 2];

    // Inner points: average of secants
    for (let i = 1; i < n - 1; i++) {
      ms[i] = (secants[i - 1] + secants[i]) / 2;
    }

    // Fritsch-Carlson Monotonicity Fixes
    for (let i = 0; i < n - 1; i++) {
        // 1. If secant is zero (flat), tangents must be zero
      if (Math.abs(secants[i]) < 1e-9) { 
        ms[i] = 0;
        ms[i + 1] = 0;
      } else {
        // 2. Strict monotonicity check for local extrema
        // If secants have different signs, then point i is a local extremum, so m[i] must be 0
        // (This check was missing or implicit. We make it explicit here for safety)
        if (i > 0) {
             const prevSecant = secants[i-1];
             const currSecant = secants[i];
             if (prevSecant * currSecant <= 0) {
                 ms[i] = 0;
             }
        }

        const alpha = ms[i] / secants[i];
        const beta = ms[i + 1] / secants[i];
        
        // If outside the monotonicity region (approx circle radius 3)
        // We strictly clamp to circle of radius 3 which is sufficient logic
        const dist = Math.sqrt(alpha * alpha + beta * beta);
        if (dist > 3) {
            const tau = 3 / dist;
            ms[i] = alpha * tau * secants[i];
            ms[i+1] = beta * tau * secants[i];
        }
      }
    }
  }



  // Pre-calculated area of each full segment (integral from x_i to x_{i+1})
  // We can also store prefix sums for O(1) access to the start of a segment.
  private cumulativeAreas: number[] = [];

  private calculateAreas() {
    const n = this.xs.length;
    this.cumulativeAreas = new Array(n).fill(0); // Index i stores area from 0 to x_i

    let total = 0;
    this.cumulativeAreas[0] = 0;

    for (let i = 0; i < n - 1; i++) {
        const h = this.xs[i+1] - this.xs[i];
        
        // Integral of cubic hermite spline over [0, 1] for u
        // I_00(1) = 0.5 - 1 + 1 = 0.5
        // I_10(1) = 0.25 - 0.66 + 0.5 = 1/12
        // I_01(1) = -0.5 + 1 = 0.5
        // I_11(1) = 0.25 - 0.33 = -1/12
        
        // Full segment area = h * ( 0.5*y0 + (h/12)*m0 + 0.5*y1 - (h/12)*m1 )
        // = h * ( (y0 + y1)/2 + (h/12)*(m0 - m1) )
        // Simpson's rule-ish?
        
        const term1 = (this.ys[i] + this.ys[i+1]) / 2;
        const term2 = (h / 12) * (this.m[i] - this.m[i+1]);
        const segmentArea = h * (term1 + term2);

        total += segmentArea;
        this.cumulativeAreas[i+1] = total;
    }
  }

  public integrate(t: number): number {
    const n = this.xs.length;
    if (n === 0) return 0;
    
    // 1. Handle Out of Bounds linearly (constant speed extrapolation)
    if (t <= this.xs[0]) {
        // Assume constant value of y[0] for t < start
        return this.ys[0] * (t - this.xs[0]); // negative area if moving left from start? 
        // Usually t starts at 0. If t < 0, just return 0? 
        // If splines are for "speed multiplier", usually defined from t=0.
        // Let's assume 0 for t < xs[0] for now, or just return 0.
        // Actually, if we stretch, t might be negative?
        // Let's stick to 0 lower bound.
        return 0;
    }
    if (t >= this.xs[n - 1]) {
        // Extrapolate with last value
        const totalArea = this.cumulativeAreas[n - 1];
        const extraTime = t - this.xs[n - 1];
        return totalArea + extraTime * this.ys[n - 1];
    }

    // 2. Find Segment
    let i = 0;
    while (t >= this.xs[i + 1] && i < n - 2) {
      i++;
    }

    // 3. Base Area up to segment start
    const baseArea = this.cumulativeAreas[i];

    // 4. Partial Area within segment
    const h = this.xs[i + 1] - this.xs[i];
    const u = (t - this.xs[i]) / h; // 0 to 1

    // Integrated Basis Functions (Quartic)
    // I_00 = 0.5u^4 - u^3 + u
    // I_10 = 0.25u^4 - (2/3)u^3 + 0.5u^2
    // I_01 = -0.5u^4 + u^3
    // I_11 = 0.25u^4 - (1/3)u^3

    const u2 = u * u;
    const u3 = u2 * u;
    const u4 = u3 * u;

    const I00 = 0.5 * u4 - u3 + u;
    const I10 = 0.25 * u4 - (2/3) * u3 + 0.5 * u2;
    const I01 = -0.5 * u4 + u3;
    const I11 = 0.25 * u4 - (1/3) * u3;

    // Area = h * [ y0*I00 + h*m0*I10 + y1*I01 + h*m1*I11 ]
    const partialArea = h * (
        this.ys[i] * I00 +
        h * this.m[i] * I10 +
        this.ys[i+1] * I01 +
        h * this.m[i+1] * I11
    );

    return baseArea + partialArea;
  }

  public at(t: number, extrapolate: boolean = false): number {
    const n = this.xs.length;
    if (n === 0) return 0;
    if (n === 1) return this.ys[0];

    // Out of bounds
    if (t <= this.xs[0]) {
        if (extrapolate) {
            return this.ys[0] + (t - this.xs[0]) * this.m[0];
        }
        return this.ys[0];
    }
    if (t >= this.xs[n - 1]) {
        if (extrapolate) {
            return this.ys[n - 1] + (t - this.xs[n - 1]) * this.m[n - 1]; // Use last tangent
        }
        return this.ys[n - 1];
    }

    // Find segment (Binary search could be utilized for large N, but N < 20 here usually)
    let i = 0;
    // Linear scan is fine for small N.
    // Optimization: Store last index could be done if class persists across frames
    while (t >= this.xs[i + 1] && i < n - 2) {
      i++;
    }

    // Perform Cubic Hermite Interpolation
    const h = this.xs[i + 1] - this.xs[i];
    const tRel = (t - this.xs[i]) / h; // 0 to 1

    const t2 = tRel * tRel;
    const t3 = t2 * tRel;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + tRel;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const y =
      h00 * this.ys[i] +
      h10 * h * this.m[i] +
      h01 * this.ys[i + 1] +
      h11 * h * this.m[i + 1];

    // Safety Clamp: Ensure value stays within the segment's range
    // ONLY IF NOT EXTRAPOLATING (Actually segment interp is always bounded by definition)
    // But float errors can exist.
    const lower = Math.min(this.ys[i], this.ys[i+1]);
    const upper = Math.max(this.ys[i], this.ys[i+1]);

    return Math.max(lower, Math.min(upper, y));
  }
  /**
   * Generates an SVG path 'd' string representing the spline.
   * The path is in the coordinate space of the data (time, value).
   * Caller is responsible for scaling/viewBox.
   */
  public getSVGPath(): string {
    const n = this.xs.length;
    if (n === 0) return "";
    
    // Start at first point
    let d = `M ${this.xs[0]} ${this.ys[0]}`;

    for (let i = 0; i < n - 1; i++) {
        const x0 = this.xs[i];
        const y0 = this.ys[i];
        const x1 = this.xs[i + 1];
        const y1 = this.ys[i + 1];
        
        const h = x1 - x0;
        const m0 = this.m[i];
        const m1 = this.m[i+1];

        // Control Points
        // C0 = P0 + T0/3
        // C1 = P1 - T1/3
        // where Ti = (h, m_i * h)
        
        const c0x = x0 + h / 3;
        const c0y = y0 + (m0 * h) / 3;
        
        const c1x = x1 - h / 3;
        const c1y = y1 - (m1 * h) / 3;

        d += ` C ${c0x} ${c0y}, ${c1x} ${c1y}, ${x1} ${y1}`;
    }

    return d;
  }

  /**
   * Solves for X given Y.
   * Assumes the spline is Monotonic.
   * 
   * Uses Cardano's method to find real roots of the cubic equation for each segment.
   */
  public solveX(y: number): number {
    const n = this.xs.length;
    if (n === 0) return 0;
    if (n === 1) return this.xs[0];

    // 1. Extrapolation / Bounds
    if (y <= this.ys[0]) {
        if (Math.abs(this.m[0]) < 1e-9) return this.xs[0]; // Flat slope
        return this.xs[0] + (y - this.ys[0]) / this.m[0];
    }
    if (y >= this.ys[n - 1]) {
        if (Math.abs(this.m[n - 1]) < 1e-9) return this.xs[n - 1];
        return this.xs[n - 1] + (y - this.ys[n - 1]) / this.m[n - 1];
    }

    // 2. Find Segment
    // Since ys are sorted (monotonic), we can binary search or linear scan
    let i = 0;
    while (y >= this.ys[i + 1] && i < n - 2) {
        i++;
    }

    // Segment i: xs[i] to xs[i+1]
    const x0 = this.xs[i];
    const x1 = this.xs[i+1];
    const y0 = this.ys[i];
    const y1 = this.ys[i+1];
    const m0 = this.m[i];
    const m1 = this.m[i+1];
    const h = x1 - x0;

    // Normalizing Y to the segment's range [0, 1] for value
    // Target Y value in local coords
    const targetY = y; 

    // Hermite Interpolation Formula:
    // y(t) = h00*y0 + h10*h*m0 + h01*y1 + h11*h*m1
    // where t is 0..1 (relative x)
    // h00 = 2t^3 - 3t^2 + 1
    // h10 = t^3 - 2t^2 + t
    // h01 = -2t^3 + 3t^2
    // h11 = t^3 - t^2
    
    // Grouping into At^3 + Bt^2 + Ct + D = targetY
    // y(t) = t^3(2y0 + h m0 - 2y1 + h m1) + t^2(-3y0 - 2h m0 + 3y1 - h m1) + t(h m0) + y0
    
    // Coefficients for P(t) = At^3 + Bt^2 + Ct + D with D shifted by -targetY to find root
    const A = 2*y0 + h*m0 - 2*y1 + h*m1;
    const B = -3*y0 - 2*h*m0 + 3*y1 - h*m1;
    const C = h*m0;
    const D = y0 - targetY;
    
    const roots = this.solveCubic(A, B, C, D);
    
    // Find the valid root in [0, 1]
    let validT = 0;

    for (const r of roots) {
        if (r >= -0.000001 && r <= 1.000001) {
             // If multiple roots (shouldn't happen for monotonic), pick one closest to range?
             // Since monotonic, there should be exactly one real root in range.
             validT = Math.max(0, Math.min(1, r));
             break;
        }
    }
    
    return x0 + validT * h;
  }

  /**
   * Solves ax^3 + bx^2 + cx + d = 0 for real roots.
   * Returns an array of real roots.
   */
  private solveCubic(a: number, b: number, c: number, d: number): number[] {
    if (Math.abs(a) < 1e-9) {
        // Quadratic: bx^2 + cx + d = 0
        if (Math.abs(b) < 1e-9) {
            // Linear: cx + d = 0
            if (Math.abs(c) < 1e-9) return [];
            return [-d / c];
        }
        const delta = c*c - 4*b*d;
        if (delta < 0) return [];
        const sqrtDelta = Math.sqrt(delta);
        return [(-c - sqrtDelta) / (2*b), (-c + sqrtDelta) / (2*b)];
    }

    // Normalized form: x^3 + Ax^2 + Bx + C = 0
    // A = b/a, B = c/a, C = d/a
    const A = b / a;
    const B = c / a;
    const C = d / a;

    // Depressed cubic: t^3 + pt + q = 0
    // Substitute x = t - A/3
    const p = B - (A * A) / 3;
    const q = (2 * A * A * A) / 27 - (A * B) / 3 + C;
    
    const discriminant = (q * q) / 4 + (p * p * p) / 27;

    const roots: number[] = [];
    const offset = A / 3;

    if (Math.abs(discriminant) < 1e-9) {
        // Two or three real roots (one repeated)
        if (Math.abs(p) < 1e-9) {
            // Triple root at 0
            roots.push(-offset);
        } else {
            // Double root and simple root
            const u = 3 * q / p;
            const v = -3 * q / (2 * p);
            roots.push(v - offset);
            roots.push(u - offset); // Single
            roots.push(v - offset); // Double
        }
    } else if (discriminant > 0) {
        // One real root
        const sqrtD = Math.sqrt(discriminant);
        const u = Math.cbrt(-q / 2 + sqrtD);
        const v = Math.cbrt(-q / 2 - sqrtD);
        roots.push(u + v - offset);
    } else {
        // Three real roots (Casus Irreducibilis)
        const rho = Math.sqrt(-(p * p * p) / 27);
        const theta = Math.acos(-q / (2 * rho));
        // Correct formula: 2 * sqrt(-p/3) * cos(...)
        
        const r = 2 * Math.sqrt(-p / 3);
        roots.push(r * Math.cos(theta / 3) - offset);
        roots.push(r * Math.cos((theta + 2 * Math.PI) / 3) - offset);
        roots.push(r * Math.cos((theta + 4 * Math.PI) / 3) - offset);
    }

    return roots;
  }
}


