import { MonotoneCubicSpline } from './MonotoneCubicSpline';

describe('MonotoneCubicSpline', () => {
  it('should not overshoot at local maximum', () => {
    // Points: (0, 0), (0.1, 1), (1, 0)
    // This creates a sharp peak.
    // Secant 1: 10
    // Secant 2: -1.111
    // Tangent avg: 4.44 (positive slope at peak!)
    // Should be clamped to 0.
    const points = [
      { time: 0, value: 0 },
      { time: 0.1, value: 1.0 },
      { time: 1.0, value: 0.0 }
    ];

    const spline = new MonotoneCubicSpline(points);

    // Check slightly after the peak
    const t = 0.11; 
    const val = spline.at(t);
    
    // In a proper monotone spline, value should be <= 1.0
    // If it overshoots, it will be > 1.0
    expect(val).toBeLessThanOrEqual(1.0);
    
    // Also check sanity
    expect(val).toBeGreaterThan(0.0);
  });

  it('should interpolate linearly for 2 points', () => {
      const points = [{ time: 0, value: 0 }, { time: 1, value: 1 }];
      const spline = new MonotoneCubicSpline(points);
      expect(spline.at(0.5)).toBeCloseTo(0.5);
  });
  
  it('should handle flat segments correctly', () => {
      const points = [
          { time: 0, value: 0 },
          { time: 0.5, value: 1 },
          { time: 1, value: 1 }
      ];
      const spline = new MonotoneCubicSpline(points);
      expect(spline.at(0.75)).toBeCloseTo(1);
      expect(spline.at(0.6)).toBeCloseTo(1);
  });
});
