import mongoose from "mongoose";
import dotenv from "dotenv";
import ResponseModel from "../models/Response";

dotenv.config();

// DEVELOPMENT ONLY. Responses made on localhost have no location (a loopback address cannot be looked up), so the
// dashboard's response map would be empty. This gives every response that has none a made-up position in a spread of
// real cities, so the map can be seen and tried. It refuses to run in production and never touches a response that
// already has a real location.
const CITIES = [
  { country: "IN", region: "MH", city: "Mumbai", lat: 19.08, lng: 72.88, weight: 6 },
  { country: "IN", region: "KA", city: "Bengaluru", lat: 12.97, lng: 77.59, weight: 5 },
  { country: "IN", region: "DL", city: "Delhi", lat: 28.61, lng: 77.21, weight: 5 },
  { country: "IN", region: "TN", city: "Chennai", lat: 13.08, lng: 80.27, weight: 3 },
  { country: "US", region: "NY", city: "New York", lat: 40.71, lng: -74.01, weight: 4 },
  { country: "US", region: "CA", city: "San Francisco", lat: 37.77, lng: -122.42, weight: 3 },
  { country: "GB", region: "ENG", city: "London", lat: 51.51, lng: -0.13, weight: 4 },
  { country: "DE", region: "BE", city: "Berlin", lat: 52.52, lng: 13.4, weight: 2 },
  { country: "AE", region: "DU", city: "Dubai", lat: 25.2, lng: 55.27, weight: 3 },
  { country: "SG", region: "01", city: "Singapore", lat: 1.35, lng: 103.82, weight: 2 },
  { country: "AU", region: "NSW", city: "Sydney", lat: -33.87, lng: 151.21, weight: 2 },
  { country: "BR", region: "SP", city: "São Paulo", lat: -23.55, lng: -46.63, weight: 1 },
  { country: "ZA", region: "WC", city: "Cape Town", lat: -33.92, lng: 18.42, weight: 1 },
];
const POOL = CITIES.flatMap((c) => Array(c.weight).fill(c));

const run = async () => {
  if (process.env.NODE_ENV === "production") throw new Error("seedResponseGeo is for development databases only.");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding");
  const todo = await ResponseModel.find({ "geo.lat": { $exists: false } }).select("_id").lean();
  const ops = todo.map((r) => {
    const c = POOL[Math.floor(Math.random() * POOL.length)];
    // A few km of jitter so repeated responses from one city do not stack on a single pixel.
    const jitter = () => (Math.random() - 0.5) * 0.12;
    return {
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { geo: { country: c.country, region: c.region, city: c.city, lat: Math.round((c.lat + jitter()) * 100) / 100, lng: Math.round((c.lng + jitter()) * 100) / 100 } } },
      },
    };
  });
  if (ops.length) await ResponseModel.bulkWrite(ops);
  console.log(`Gave ${ops.length} responses a demo location.`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
