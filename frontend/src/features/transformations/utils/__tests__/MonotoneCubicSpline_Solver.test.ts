
import { MonotoneCubicSpline } from "../MonotoneCubicSpline";

describe("MonotoneCubicSpline Solver", () => {
    it("solves X for Y in a linear spline", () => {
        const points = [
            { time: 0, value: 0 },
            { time: 10, value: 100 }
        ];
        const spline = new MonotoneCubicSpline(points);

        expect(spline.solveX(0)).toBeCloseTo(0);
        expect(spline.solveX(100)).toBeCloseTo(10);
        expect(spline.solveX(50)).toBeCloseTo(5);
        expect(spline.solveX(25)).toBeCloseTo(2.5);
    });

    it("solves X for Y in a simple monotonic curve", () => {
        // y = x^2 approx
        const points = [
            { time: 0, value: 0 },
            { time: 5, value: 25 },
            { time: 10, value: 100 }
        ];
        const spline = new MonotoneCubicSpline(points);

        // At t=5, y=25
        expect(spline.solveX(25)).toBeCloseTo(5);
        
        // At t=0, y=0
        expect(spline.solveX(0)).toBeCloseTo(0);

        // At t=10, y=100
        expect(spline.solveX(100)).toBeCloseTo(10);

        // Intermediate
        const xTarget = 7.5;
        const yTarget = spline.at(xTarget);
        expect(spline.solveX(yTarget)).toBeCloseTo(xTarget);
    });

    it("handles out of bounds by extrapolation", () => {
        const points = [
            { time: 0, value: 0 },
            { time: 10, value: 100 }
        ];
        const spline = new MonotoneCubicSpline(points);

        // Lower bound (assuming linear extrapolation)
        // y = 10x
        expect(spline.solveX(-10)).toBeCloseTo(-1);

        // Upper bound
        expect(spline.solveX(110)).toBeCloseTo(11);
    });

    it("solves specific cubic accurately", () => {
        // Create a distinct "S" curve
        const points = [
            { time: 0, value: 0 },
            { time: 0.5, value: 0.1 }, // Slow start
            { time: 1.0, value: 1.0 }  // Fast end
        ];
        const spline = new MonotoneCubicSpline(points);
        
        // Midpoint check
        const x = 0.75;
        const y = spline.at(x);
        
        // Inversion check
        const solvedX = spline.solveX(y);
        expect(solvedX).toBeCloseTo(x, 4);
    });

    it("correctly inverts strictly monotonic data (Round Trip)", () => {
        const points = [
            { time: 0, value: 0 },
            { time: 2, value: 10 },
            { time: 5, value: 25 },
            { time: 10, value: 100 }
        ];
        const spline = new MonotoneCubicSpline(points);
        
        const testValues = [5, 15, 30, 60, 90, 99, 105]; // 105 checks extrapolation
        for (const y of testValues) {
            const analyticX = spline.solveX(y);
            const y_recaptured = spline.at(analyticX, true); // Enable extrapolation check
            
            // Should be very close
            expect(y_recaptured).toBeCloseTo(y, 3);
        }
    });
});
