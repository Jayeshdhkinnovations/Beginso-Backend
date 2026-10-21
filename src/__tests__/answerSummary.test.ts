import { numericSummary, ratingSummary, yesNoSummary, toNumbers } from "../utils/answerSummary";

describe("toNumbers", () => {
  it("keeps numbers and numeric strings, drops blanks, booleans, words and non-finite values", () => {
    expect(toNumbers([1, "2", " 3.5 ", "", "n/a", true, null, undefined, NaN, Infinity, {}])).toEqual([1, 2, 3.5]);
  });
});

describe("ratingSummary", () => {
  it("averages, and counts every value on the scale including the ones nobody chose", () => {
    const s = ratingSummary([5, 4, 4, 1], 5)!;
    expect(s.count).toBe(4);
    expect(s.average).toBe(3.5);
    expect(s.max).toBe(5);
    expect(s.distribution.map((d) => d.count)).toEqual([1, 0, 0, 2, 1]);
    expect(s.distribution[3]).toEqual({ value: 4, count: 2, percentage: 50 });
  });

  it("reads string ratings, rounds fractions, and grows the scale if a value exceeds it", () => {
    const s = ratingSummary(["3", 2.6, 7], 5)!;
    expect(s.max).toBe(7);
    expect(s.distribution).toHaveLength(7);
    expect(s.average).toBe(4.33);
  });

  it("is null when there is nothing to summarise", () => {
    expect(ratingSummary([], 5)).toBeNull();
    expect(ratingSummary(["", "n/a", 0], 5)).toBeNull();
  });
});

describe("numericSummary", () => {
  it("returns count, average, min, max and sum", () => {
    expect(numericSummary([10, "20", 30.5])).toEqual({ count: 3, average: 20.17, min: 10, max: 30.5, sum: 60.5 });
  });
  it("is null for no numbers", () => {
    expect(numericSummary(["x", ""])).toBeNull();
  });
});

describe("yesNoSummary", () => {
  it("splits yes and no across the ways a value can be stored", () => {
    expect(yesNoSummary(["Yes", "yes", true, "No", false, "maybe"])).toEqual({ yes: 3, no: 2, percentageYes: 60 });
  });
  it("is null when nobody gave a yes or a no", () => {
    expect(yesNoSummary([])).toBeNull();
    expect(yesNoSummary(["maybe"])).toBeNull();
  });
});
