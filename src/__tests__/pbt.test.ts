// Mock Firebase Admin Authentication offline
jest.mock("firebase-admin/auth", () => {
  return {
    getAuth: () => {
      return {
        createUser: async (data: any) => {
          return { uid: `mock-uid-${data.email}` };
        },
        verifyIdToken: async (token: string) => {
          if (token === "invalid-token") {
            throw new Error("Invalid Firebase token.");
          }
          return {
            uid: "mock-uid-session",
            email: "sessionuser@test.com",
            name: "Session User",
          };
        },
        deleteUser: async () => {
          return {};
        },
      };
    },
  };
});

jest.mock("firebase-admin/app", () => {
  return {
    initializeApp: () => {},
    cert: () => {},
    getApps: () => [],
  };
});

process.env.JWT_SECRET = "test-secret-key-pbt-1234567890-test-key-long-enough";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import fc from "fast-check";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
}, 900000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Form API Property-Based Testing", () => {
  let adminA: any;
  let adminB: any;
  let wsA: any;
  let wsB: any;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    // Disconnect and clean
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }

    adminA = await User.create({
      firebaseUid: "admin-a-pbt",
      fullName: "Admin A",
      email: "admina.pbt@test.com",
      role: "admin",
    });

    adminB = await User.create({
      firebaseUid: "admin-b-pbt",
      fullName: "Admin B",
      email: "adminb.pbt@test.com",
      role: "admin",
    });

    wsA = await Workspace.create({ name: "Workspace A", owner: adminA._id });
    wsB = await Workspace.create({ name: "Workspace B", owner: adminB._id });

    adminA.workspaceId = wsA._id;
    await adminA.save();

    adminB.workspaceId = wsB._id;
    await adminB.save();

    tokenA = jwt.sign(
      { id: adminA._id.toString(), email: adminA.email, role: adminA.role },
      process.env.JWT_SECRET!
    );

    tokenB = jwt.sign(
      { id: adminB._id.toString(), email: adminB.email, role: adminB.role },
      process.env.JWT_SECRET!
    );
  });

  const baseArb = {
    label: fc.string({ minLength: 3, maxLength: 20 }).map(s => s.trim().replace(/[^a-zA-Z0-9 ]/g, "A") + "a"),
    required: fc.boolean(),
    deleted: fc.constant(false),
  };

  const textArb = fc.record({
    ...baseArb,
    type: fc.constant("short_text" as const),
    minLength: fc.integer({ min: 0, max: 5 }),
    maxLength: fc.integer({ min: 6, max: 50 }),
  });

  const textareaArb = fc.record({
    ...baseArb,
    type: fc.constant("long_text" as const),
    minLength: fc.integer({ min: 0, max: 5 }),
    maxLength: fc.integer({ min: 6, max: 50 }),
  });

  const emailArb = fc.record({
    ...baseArb,
    type: fc.constant("email" as const),
  });

  const phoneArb = fc.record({
    ...baseArb,
    type: fc.constant("phone" as const),
    pattern: fc.constant("^\\+?[0-9]{10,15}$"),
  });

  const numberArb = fc.record({
    ...baseArb,
    type: fc.constant("number" as const),
    min: fc.integer({ min: -50, max: 0 }),
    max: fc.integer({ min: 1, max: 50 }),
  });

  const dateArb = fc.record({
    ...baseArb,
    type: fc.constant("date" as const),
    minDate: fc.constant("2026-01-01"),
    maxDate: fc.constant("2026-12-31"),
  });

  const dropdownArb = fc.record({
    ...baseArb,
    type: fc.constant("dropdown" as const),
    options: fc.array(fc.string({ minLength: 1, maxLength: 8 }).map(s => s.trim().replace(/[^a-zA-Z0-9]/g, "O") + "o"), { minLength: 1, maxLength: 3 }),
  });

  const multipleChoiceArb = fc.record({
    ...baseArb,
    type: fc.constant("multiple_choice" as const),
    options: fc.array(fc.string({ minLength: 1, maxLength: 8 }).map(s => s.trim().replace(/[^a-zA-Z0-9]/g, "O") + "o"), { minLength: 1, maxLength: 3 }),
  });

  const checkboxArb = fc.record({
    ...baseArb,
    type: fc.constant("checkbox" as const),
    options: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 8 }).map(s => s.trim().replace(/[^a-zA-Z0-9]/g, "O") + "o"), { minLength: 1, maxLength: 3 }), { nil: undefined }),
  });

  const fileArb = fc.record({
    ...baseArb,
    type: fc.constant("file_upload" as const),
    maxFileSize: fc.integer({ min: 1, max: 10 }),
    allowedMimeTypes: fc.array(fc.constantFrom("image/png", "image/jpeg", "application/pdf"), { minLength: 1, maxLength: 2 }),
  });

  const validFieldArb: fc.Arbitrary<any> = fc.oneof(
    textArb,
    textareaArb,
    emailArb,
    phoneArb,
    numberArb,
    dateArb,
    dropdownArb,
    multipleChoiceArb,
    checkboxArb,
    fileArb
  );

  const validFormArb = fc.record({
    title: fc.string({ minLength: 4, maxLength: 30 }).map(s => s.trim().replace(/[^a-zA-Z0-9 ]/g, "T") + "test"),
    description: fc.string({ minLength: 0, maxLength: 100 }).map(s => s.trim().replace(/[^a-zA-Z0-9 ]/g, "D")),
    status: fc.constantFrom("draft", "published", "closed"),
    fields: fc.array(validFieldArb, { minLength: 1, maxLength: 5 }),
  });

  // 1. Create -> Read Round-Trip Property Test
  it("Property: create->read round-trip invariant", async () => {
    await fc.assert(
      fc.asyncProperty(validFormArb, async (formInput) => {
        // Create Form
        const createRes = await request(app)
          .post("/api/forms")
          .set("Authorization", `Bearer ${tokenA}`)
          .send(formInput);

        expect(createRes.status).toBe(201);
        expect(createRes.body.success).toBe(true);
        const formId = createRes.body.form._id;

        // Read Form
        const readRes = await request(app)
          .get(`/api/forms/${formId}`)
          .set("Authorization", `Bearer ${tokenA}`);

        expect(readRes.status).toBe(200);
        const readForm = readRes.body.form;

        // Roundtrip checks
        expect(readForm.title).toBe(formInput.title);
        expect(readForm.description).toBe(formInput.description);
        expect(readForm.status).toBe(formInput.status);
        expect(readForm.fields).toHaveLength(formInput.fields.length);

        for (let i = 0; i < readForm.fields.length; i++) {
          const expected = formInput.fields[i] as any;
          const actual = readForm.fields[i] as any;
          expect(actual.label).toBe(expected.label);
          expect(actual.type).toBe(expected.type);
          expect(actual.required).toBe(expected.required);
        }

        // Cleanup after each iteration to prevent DB bloat/collisions
        await Form.findByIdAndDelete(formId);
      }),
      { numRuns: 20 } // Limit runs for test suite execution speed
    );
  });

  // 2. Update Idempotency Property Test
  it("Property: update-idempotency invariant", async () => {
    // Setup a static form first
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Initial Form",
        fields: [{ label: "Original Text", type: "short_text" }]
      });
    const formId = createRes.body.form._id;

    await fc.assert(
      fc.asyncProperty(validFormArb, async (formUpdateInput) => {
        // Run update 1
        const updateRes1 = await request(app)
          .put(`/api/forms/${formId}`)
          .set("Authorization", `Bearer ${tokenA}`)
          .send(formUpdateInput);

        expect(updateRes1.status).toBe(200);
        const state1 = updateRes1.body.form;

        // Run update 2 (sending back the fields with server-generated fieldIds to preserve identity)
        const updateRes2 = await request(app)
          .put(`/api/forms/${formId}`)
          .set("Authorization", `Bearer ${tokenA}`)
          .send({
            ...formUpdateInput,
            fields: state1.fields
          });

        expect(updateRes2.status).toBe(200);
        const state2 = updateRes2.body.form;

        // Compare state1 and state2
        expect(state2.title).toBe(state1.title);
        expect(state2.description).toBe(state1.description);
        expect(state2.status).toBe(state1.status);
        expect(state2.schemaVersion).toBe(state1.schemaVersion); // Should NOT increment schemaVersion since no changes occurred
        expect(state2.fields).toHaveLength(state1.fields.length);

        for (let i = 0; i < state2.fields.length; i++) {
          expect(state2.fields[i].label).toBe(state1.fields[i].label);
          expect(state2.fields[i].type).toBe(state1.fields[i].type);
          expect(state2.fields[i].fieldId).toBe(state1.fields[i].fieldId);
        }
      }),
      { numRuns: 20 }
    );

    // Cleanup
    await Form.findByIdAndDelete(formId);
  });

  // 3. Workspace Isolation Invariant Property Test
  it("Property: workspace-isolation invariant under adversarial requests", async () => {
    // Setup Form under Admin A
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Admin A Form",
        fields: [{ label: "A Text", type: "short_text" }]
      });
    const formId = createRes.body.form._id;

    // Generate random actions: GET, PUT, PATCH, DELETE, duplicate
    const actionArb = fc.constantFrom("GET", "PUT", "PATCH", "DELETE", "duplicate");

    await fc.assert(
      fc.asyncProperty(actionArb, validFormArb, async (action, updatePayload) => {
        let res: any;

        if (action === "GET") {
          res = await request(app)
            .get(`/api/forms/${formId}`)
            .set("Authorization", `Bearer ${tokenB}`);
        } else if (action === "PUT") {
          res = await request(app)
            .put(`/api/forms/${formId}`)
            .set("Authorization", `Bearer ${tokenB}`)
            .send(updatePayload);
        } else if (action === "PATCH") {
          res = await request(app)
            .patch(`/api/forms/${formId}`)
            .set("Authorization", `Bearer ${tokenB}`)
            .send({ title: "Mutated Title" });
        } else if (action === "DELETE") {
          res = await request(app)
            .delete(`/api/forms/${formId}`)
            .set("Authorization", `Bearer ${tokenB}`);
        } else {
          // duplicate
          res = await request(app)
            .post(`/api/forms/${formId}/duplicate`)
            .set("Authorization", `Bearer ${tokenB}`);
        }

        // Assert that all operations on Admin A's form by Admin B are 403 Forbidden
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error.message).toContain("Forbidden");
      }),
      { numRuns: 30 }
    );

    // Cleanup
    await Form.findByIdAndDelete(formId);
  });

  // 4. Publish / Close Invariant Property Test
  it("Property: publish and close lifecycle invariant", async () => {
    await fc.assert(
      fc.asyncProperty(validFormArb, async (formInput) => {
        // Create Form (starts as draft)
        const createRes = await request(app)
          .post("/api/forms")
          .set("Authorization", `Bearer ${tokenA}`)
          .send(formInput);
        expect(createRes.status).toBe(201);
        const formId = createRes.body.form._id;

        // Publish Form
        const publishRes = await request(app)
          .post(`/api/forms/${formId}/publish`)
          .set("Authorization", `Bearer ${tokenA}`);
        expect(publishRes.status).toBe(200);
        expect(publishRes.body.success).toBe(true);
        expect(publishRes.body.status).toBe("published");
        expect(publishRes.body.slug).toBeDefined();

        // Close Form
        const closeRes = await request(app)
          .post(`/api/forms/${formId}/close`)
          .set("Authorization", `Bearer ${tokenA}`);
        expect(closeRes.status).toBe(200);
        expect(closeRes.body.success).toBe(true);
        expect(closeRes.body.status).toBe("closed");

        // Cleanup
        await Form.findByIdAndDelete(formId);
      }),
      { numRuns: 10 }
    );
  });

  // 5. Duplicate Invariant Property Test
  it("Property: duplicate form copy invariant", async () => {
    await fc.assert(
      fc.asyncProperty(validFormArb, async (formInput) => {
        // Create Form
        const createRes = await request(app)
          .post("/api/forms")
          .set("Authorization", `Bearer ${tokenA}`)
          .send(formInput);
        expect(createRes.status).toBe(201);
        const formId = createRes.body.form._id;

        // Duplicate Form
        const duplicateRes = await request(app)
          .post(`/api/forms/${formId}/duplicate`)
          .set("Authorization", `Bearer ${tokenA}`);
        expect(duplicateRes.status).toBe(201);
        expect(duplicateRes.body.success).toBe(true);
        
        const dupForm = duplicateRes.body.form;
        expect(dupForm).toBeDefined();
        expect(dupForm._id).not.toBe(formId);
        expect(dupForm.title).toBe(`Copy of ${formInput.title}`);
        expect(dupForm.fields.length).toBe(formInput.fields.length);
        expect(dupForm.status).toBe("draft");
        expect(dupForm.publishedSlug).toBeUndefined();

        // Cleanup
        await Form.findByIdAndDelete(formId);
        await Form.findByIdAndDelete(dupForm._id);
      }),
      { numRuns: 10 }
    );
  });

  // 6. Delete Cascade Completeness Property Test
  it("Property: delete-cascade completeness and disk sweep", async () => {
    // Setup UPLOAD_DIR env for testing to avoid polluting actual uploads
    const testPbtUploadDir = path.join(process.cwd(), "test_pbt_uploads");
    process.env.UPLOAD_DIR = testPbtUploadDir;
    if (!fs.existsSync(testPbtUploadDir)) {
      fs.mkdirSync(testPbtUploadDir, { recursive: true });
    }

    await fc.assert(
      fc.asyncProperty(validFormArb, async (formInput) => {
        // Ensure all fields have unique labels to avoid key collisions in answers
        const seenLabels = new Set<string>();
        seenLabels.add("PBT Resume");
        const uniqueFields: any[] = [];
        for (const field of formInput.fields) {
          let label = field.label;
          let counter = 1;
          while (seenLabels.has(label)) {
            label = `${field.label}_${counter++}`;
          }
          seenLabels.add(label);
          uniqueFields.push({
            ...field,
            label,
          });
        }

        const formPayload = {
          ...formInput,
          status: "published",
          fields: [
            ...uniqueFields,
            {
              label: "PBT Resume",
              type: "file_upload",
              required: false,
            },
          ],
        };

        const createRes = await request(app)
          .post("/api/forms")
          .set("Authorization", `Bearer ${tokenA}`)
          .send(formPayload);
        expect(createRes.status).toBe(201);
        const formId = createRes.body.form._id;

        // Create a fake physical file on disk and its metadata Upload record in DB
        const fakeFilename = `pbt-test-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
        const fakeFilePath = path.join(testPbtUploadDir, fakeFilename);
        fs.writeFileSync(fakeFilePath, "fake content");

        const uploadRecord = await Upload.create({
          name: "resume.png",
          size: 12,
          type: "image/png",
          path: fakeFilename,
          owner: adminA._id,
        });

        // Submit a response pre-populated with the uploaded file
        const answers: Record<string, any> = {
          "PBT Resume": {
            fileName: fakeFilename,
            fileSize: 12,
            mimeType: "image/png",
          },
        };
        // Fill other required fields with dummy values
        for (const field of formPayload.fields) {
          if (field.label !== "PBT Resume") {
            let val: any = "dummy";
            if (field.type === "short_text" || field.type === "long_text") {
              const minL = field.minLength !== undefined ? field.minLength : 0;
              const maxL = field.maxLength !== undefined ? field.maxLength : 50;
              const targetLen = Math.max(minL, Math.min(maxL, 5));
              val = "dummy".repeat(Math.ceil(targetLen / 5)).substring(0, targetLen);
            } else if (field.type === "number") {
              const minVal = field.min !== undefined ? field.min : -10;
              const maxVal = field.max !== undefined ? field.max : 10;
              val = Math.round((minVal + maxVal) / 2);
            } else if (field.type === "dropdown" || field.type === "multiple_choice") {
              val = field.options && field.options.length > 0 ? field.options[0] : "option";
            } else if (field.type === "checkbox") {
              val = field.options && field.options.length > 0 ? [field.options[0]] : true;
            } else if (field.type === "date") {
              val = "2026-06-01";
            } else if (field.type === "email") {
              val = "test@example.com";
            } else if (field.type === "phone") {
              val = "+1234567890";
            } else if (field.type === "file_upload") {
              const mime = field.allowedMimeTypes && field.allowedMimeTypes.length > 0
                ? field.allowedMimeTypes[0]
                : "image/png";
              val = {
                fileName: fakeFilename,
                fileSize: 12,
                mimeType: mime,
              };
            }
            // Avoid overwriting a valid file upload answer with a dummy one if labels collide
            if (!answers[field.label] || answers[field.label].fileName === undefined) {
              answers[field.label] = val;
            }
          }
        }

        const submitRes = await request(app)
          .post(`/api/forms/${formId}/submissions`)
          .set("Authorization", `Bearer ${tokenA}`)
          .send({ answers });
        if (submitRes.status !== 201) {
          console.log("SUBMIT STATUS:", submitRes.status);
          console.log("SUBMIT BODY:", JSON.stringify(submitRes.body, null, 2));
          console.log("ANSWERS:", JSON.stringify(answers, null, 2));
          console.log("FIELDS:", JSON.stringify(formPayload.fields, null, 2));
        }
        expect(submitRes.status).toBe(201);

        // Verify response is in DB
        const initialResponses = await ResponseModel.find({ formId });
        expect(initialResponses.length).toBe(1);

        // Delete the form: Sprint 13 moves it to Trash (200), then a permanent delete removes it for good.
        const deleteRes = await request(app)
          .delete(`/api/forms/${formId}`)
          .set("Authorization", `Bearer ${tokenA}`);
        expect(deleteRes.status).toBe(200);
        const purgeRes = await request(app)
          .delete(`/api/trash/form/${formId}`)
          .set("Authorization", `Bearer ${tokenA}`)
          .send({ confirm: "DELETE" });
        expect(purgeRes.status).toBe(200);

        // Verify form is deleted
        const dbForm = await Form.findOne({ _id: formId }).setOptions({ includeDeleted: true });
        expect(dbForm).toBeNull();

        // Verify responses are deleted (cascade)
        const dbResponses = await ResponseModel.find({ formId });
        expect(dbResponses.length).toBe(0);

        // Verify Upload metadata record is deleted (cascade)
        const dbUpload = await Upload.findById(uploadRecord._id);
        expect(dbUpload).toBeNull();

        // Verify physical file is swept from disk (cascade)
        expect(fs.existsSync(fakeFilePath)).toBe(false);
      }),
      { numRuns: 5 } // Small number of runs due to I/O operations
    );

    // Clean up directory
    if (fs.existsSync(testPbtUploadDir)) {
      fs.rmSync(testPbtUploadDir, { recursive: true, force: true });
    }
  });

  // 7. Hidden fields are never persisted
  it("Property: hidden fields are never persisted as required/answered", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("hide-me", "other-value"),
        async (triggerVal) => {
          // Create a form with conditional logic
          const formPayload = {
            title: "PBT Hidden Fields Test",
            fields: [
              {
                fieldId: "trigger-id",
                label: "Trigger",
                type: "short_text",
                required: true,
                logicRules: [
                  { targetFieldId: "target-id", action: "hide", value: "hide-me" }
                ]
              },
              {
                fieldId: "target-id",
                label: "Target",
                type: "short_text",
                required: false
              }
            ]
          };

          const createRes = await request(app)
            .post("/api/forms")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(formPayload);
          expect(createRes.status).toBe(201);
          const formId = createRes.body.form._id;

          // Publish it so we can submit
          const pubRes = await request(app)
            .post(`/api/forms/${formId}/publish`)
            .set("Authorization", `Bearer ${tokenA}`);
          expect(pubRes.status).toBe(200);
          const pubSlug = pubRes.body.slug;

          if (triggerVal === "hide-me") {
            // Target is hidden, so even if we submit Target, it should be stripped
            const submitRes = await request(app)
              .post(`/api/public/${pubSlug}/submit`)
              .field("data", JSON.stringify({ Trigger: "hide-me", Target: "should-be-ignored" }));
            expect(submitRes.status).toBe(200);

            // Assert it's persisted but Target is stripped
            const responseDoc = await ResponseModel.findOne({ formId });
            expect(responseDoc).not.toBeNull();
            expect(responseDoc?.answers.Trigger).toBe("hide-me");
            expect(responseDoc?.answers.Target).toBeUndefined();
            expect(responseDoc?.answers["target-id"]).toBeUndefined();
          } else {
            // Target is NOT hidden, so submitting Target should persist it
            const submitRes = await request(app)
              .post(`/api/public/${pubSlug}/submit`)
              .field("data", JSON.stringify({ Trigger: "other-value", Target: "should-be-persisted" }));
            expect(submitRes.status).toBe(200);

            const responseDoc = await ResponseModel.findOne({ formId });
            expect(responseDoc).not.toBeNull();
            expect(responseDoc?.answers.Trigger).toBe("other-value");
            expect(responseDoc?.answers.Target).toBe("should-be-persisted");
          }

          // Cleanup
          await Form.findByIdAndDelete(formId);
          await ResponseModel.deleteMany({ formId });
        }
      ),
      { numRuns: 10 }
    );
  });

  // 8. Honeypot never persists response documents
  it("Property: honeypot-filled submissions never create a response document", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (hpValue) => {
          const formPayload = {
            title: "PBT Honeypot Test",
            fields: [
              {
                fieldId: "field-1",
                label: "Email",
                type: "email",
                required: true,
              }
            ],
            settings: {
              honeypotEnabled: true
            }
          };

          const createRes = await request(app)
            .post("/api/forms")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(formPayload);
          expect(createRes.status).toBe(201);
          const formId = createRes.body.form._id;

          const pubRes = await request(app)
            .post(`/api/forms/${formId}/publish`)
            .set("Authorization", `Bearer ${tokenA}`);
          expect(pubRes.status).toBe(200);
          const pubSlug = pubRes.body.slug;

          const submitRes = await request(app)
            .post(`/api/public/${pubSlug}/submit`)
            .field("data", JSON.stringify({ Email: "spam@bot.com" }))
            .field("_hp", hpValue);

          expect(submitRes.status).toBe(200);
          expect(submitRes.body.success).toBe(true);

          const responseDoc = await ResponseModel.findOne({ formId });
          expect(responseDoc).toBeNull();

          // Cleanup
          await Form.findByIdAndDelete(formId);
        }
      ),
      { numRuns: 10 }
    );
  });

  // 9. Server-side validation matches frontend rules
  it("Property: server-side validation rejects the same invalid inputs the frontend blocks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          {
            type: "email" as const,
            invalidValue: "not-an-email",
            expectedError: "valid email"
          },
          {
            type: "number" as const,
            invalidValue: 5,
            min: 10,
            expectedError: "at least 10"
          },
          {
            type: "number" as const,
            invalidValue: 25,
            max: 20,
            expectedError: "cannot exceed 20"
          },
          {
            type: "short_text" as const,
            invalidValue: "too-long-text",
            maxLength: 5,
            expectedError: "cannot exceed 5"
          },
          {
            type: "date" as const,
            invalidValue: "2025-12-31",
            minDate: "2026-01-01",
            expectedError: "cannot be earlier than"
          }
        ),
        async (testCase) => {
          const formPayload = {
            title: "PBT Validation Test",
            fields: [
              {
                fieldId: "test-field",
                label: "TestField",
                type: testCase.type,
                required: true,
                min: testCase.min,
                max: testCase.max,
                maxLength: testCase.maxLength,
                minDate: testCase.minDate,
              }
            ]
          };

          const createRes = await request(app)
            .post("/api/forms")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(formPayload);
          expect(createRes.status).toBe(201);
          const formId = createRes.body.form._id;

          const pubRes = await request(app)
            .post(`/api/forms/${formId}/publish`)
            .set("Authorization", `Bearer ${tokenA}`);
          expect(pubRes.status).toBe(200);
          const pubSlug = pubRes.body.slug;

          const submitRes = await request(app)
            .post(`/api/public/${pubSlug}/submit`)
            .field("data", JSON.stringify({ TestField: testCase.invalidValue }));

          expect(submitRes.status).toBe(422);
          expect(submitRes.body.errors[0].message.toLowerCase()).toContain(testCase.expectedError.toLowerCase());

          // Cleanup
          await Form.findByIdAndDelete(formId);
        }
      ),
      { numRuns: 10 }
    );
  });

  // 10. Multi-page submission persists all answers
  it("Property: a valid multi-page submission persists answers for every page", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          valPage1: fc.string({ minLength: 1, maxLength: 10 }),
          valPage2: fc.string({ minLength: 1, maxLength: 10 })
        }),
        async (values) => {
          const formPayload = {
            title: "PBT Multi-Page Test",
            pages: [
              { id: "page-1", order: 1, title: "Page 1" },
              { id: "page-2", order: 2, title: "Page 2" }
            ],
            fields: [
              {
                fieldId: "field-p1",
                label: "LabelP1",
                type: "short_text",
                pageId: "page-1",
                required: true,
              },
              {
                fieldId: "field-p2",
                label: "LabelP2",
                type: "short_text",
                pageId: "page-2",
                required: true,
              }
            ]
          };

          const createRes = await request(app)
            .post("/api/forms")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(formPayload);
          expect(createRes.status).toBe(201);
          const formId = createRes.body.form._id;

          const pubRes = await request(app)
            .post(`/api/forms/${formId}/publish`)
            .set("Authorization", `Bearer ${tokenA}`);
          expect(pubRes.status).toBe(200);
          const pubSlug = pubRes.body.slug;

          const submitRes = await request(app)
            .post(`/api/public/${pubSlug}/submit`)
            .field("data", JSON.stringify({ LabelP1: values.valPage1, LabelP2: values.valPage2 }));

          expect(submitRes.status).toBe(200);
          expect(submitRes.body.success).toBe(true);

          const responseDoc = await ResponseModel.findOne({ formId });
          expect(responseDoc).not.toBeNull();
          expect(responseDoc?.answers.LabelP1).toBe(values.valPage1);
          expect(responseDoc?.answers.LabelP2).toBe(values.valPage2);

          // Cleanup
          await Form.findByIdAndDelete(formId);
          await ResponseModel.deleteMany({ formId });
        }
      ),
      { numRuns: 10 }
    );
  });

  it("Property: pagination never exceeds bounds (data.length <= limit, limit capped at 50, offsets within total)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 100 }),
        async (page, inputLimit) => {
          const res = await request(app)
            .get(`/api/responses?page=${page}&limit=${inputLimit}`)
            .set("Authorization", `Bearer ${tokenA}`);

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          const effectiveLimit = Math.min(inputLimit, 50);
          expect(res.body.limit).toBe(effectiveLimit);
          expect(res.body.data.length).toBeLessThanOrEqual(effectiveLimit);
          expect(res.body.total).toBeGreaterThanOrEqual(0);
          expect(res.body.page).toBe(page);
        }
      ),
      { numRuns: 15 }
    );
  });

  it("Property: a status PATCH only ever changes status (and updatedAt); no other field mutates", async () => {
    // Create temporary form & response for Admin A
    const form = await Form.create({
      title: "PBT Status Mutate Form",
      workspaceId: wsA._id,
      status: "published",
      publishedSlug: "pbt-status-mutate-slug",
      fields: [],
    });
    const originalResp = await ResponseModel.create({
      formId: form._id,
      answers: { PBTKey: "PBTValue123" },
      status: "new",
      submittedAt: new Date(),
      ipHash: "1111222233334444",
    });

    const statusOptions = ["new", "in_progress", "completed"];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...statusOptions),
        async (targetStatus) => {
          const res = await request(app)
            .patch(`/api/responses/${originalResp._id}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ status: targetStatus });

          expect(res.status).toBe(200);
          expect(res.body.response.status).toBe(targetStatus);
          // Verify immutable fields remain untouched
          expect(res.body.response._id.toString()).toBe(originalResp._id.toString());
          expect(res.body.response.formId.toString()).toBe(form._id.toString());
          expect(res.body.response.answers.PBTKey).toBe("PBTValue123");
          expect(res.body.response.ipHash).toBe("1111222233334444");
        }
      ),
      { numRuns: 10 }
    );

    await Form.findByIdAndDelete(form._id);
    await ResponseModel.deleteMany({ formId: form._id });
  });

  it("Property: file-download route requires file to belong to response's workspace (cross-workspace returns 403)", async () => {
    // Create form & response for Admin A
    const formA = await Form.create({
      title: "PBT File Iso Form",
      workspaceId: wsA._id,
      status: "published",
      publishedSlug: "pbt-file-iso-slug",
      fields: [],
    });
    const respA = await ResponseModel.create({
      formId: formA._id,
      answers: {},
      status: "completed",
    });

    // Create file metadata under Admin A's ownership
    const uploadDoc = await Upload.create({
      name: "pbt-test-file.pdf",
      size: 500,
      type: "application/pdf",
      path: `${adminA._id}/${formA._id}/responses/${respA._id}/pbt-test-file.pdf`,
      owner: adminA._id,
      isBranding: false,
    });

    // Admin B attempting to download Admin A's file MUST be rejected with 403
    const res = await request(app)
      .get(`/api/responses/${respA._id}/file/${uploadDoc._id}`)
      .set("Authorization", `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);

    await Form.findByIdAndDelete(formA._id);
    await ResponseModel.deleteMany({ formId: formA._id });
    await Upload.findByIdAndDelete(uploadDoc._id);
  });

  it("Property: internal storage key/disk path is NEVER present in any response payload", async () => {
    const res = await request(app)
      .get("/api/responses?limit=10")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);

    for (const item of res.body.data) {
      expect(item.path).toBeUndefined();
      expect(item.r2Key).toBeUndefined();
      if (item.response_files) {
        for (const file of item.response_files) {
          expect(file.path).toBeUndefined();
          expect(file.r2Key).toBeUndefined();
          expect(file.url).toBeDefined();
          expect(file.url).toContain("/api/upload/file/");
        }
      }
    }
  });
});
