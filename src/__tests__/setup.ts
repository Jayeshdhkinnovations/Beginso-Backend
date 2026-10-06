// Global Jest setup (jest.config.ts -> setupFilesAfterEnv). Keeps tests hermetic:
// no real SMTP connection, no real Firebase/Google call, and a readable log.
// A test file can still override any mock below with its own jest.mock().

// Tests mint bare JWTs without a Session row; production protect() rejects those (auth.middleware).
process.env.ALLOW_SESSIONLESS_TOKENS = "true";

// Never let a test open a socket to the real mail server.
jest.mock("nodemailer", () => {
  const transport = {
    sendMail: async () => ({ messageId: "test-message-id" }),
    verify: async () => true,
  };
  const createTransport = () => transport;
  return { __esModule: true, default: { createTransport }, createTransport };
});

// Default Firebase Admin auth stub. The real SDK, given the dummy test credentials, tries to
// fetch a Google OAuth token over the network on every call.
jest.mock("firebase-admin/auth", () => {
  const notFound = () => Object.assign(new Error("There is no user record"), { code: "auth/user-not-found" });
  const methods: Record<string, (...args: any[]) => Promise<any>> = {
    createUser: async (data: any) => ({ uid: `mock-uid-${data?.email ?? "user"}` }),
    getUserByEmail: async () => {
      throw notFound();
    },
    // Reauth tokens for account deletion look like "reauth-<firebaseUid>"; anything else is rejected.
    verifyIdToken: async (token: string) => {
      if (typeof token === "string" && token.startsWith("reauth-")) {
        return { uid: token.slice("reauth-".length), auth_time: Math.floor(Date.now() / 1000) };
      }
      throw new Error("verifyIdToken is not mocked in this test");
    },
  };
  const authStub = new Proxy(methods, {
    get: (target, prop: string) => (prop === "then" ? undefined : (target[prop] ?? (async () => ({})))),
  });
  return { getAuth: () => authStub };
});

// Console: drop chatty info logs and warnings that tests provoke on purpose.
// Real errors still print. Set JEST_VERBOSE_CONSOLE=1 to see everything.
if (!process.env.JEST_VERBOSE_CONSOLE) {
  const expectedNoise = [
    /Firebase serviceAccountKey\.json is missing/,
    /\[WARN\] Client Request Warning/,
    /Failed to write (info|warn|error) log to MongoDB/,
    /JWT Verification Error/, // logged for every deliberately-invalid token in 401 tests
  ];
  const isNoise = (args: unknown[]) => typeof args[0] === "string" && expectedNoise.some((re) => re.test(args[0] as string));

  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);
  console.log = () => {};
  console.info = () => {};
  console.warn = (...args: unknown[]) => {
    if (!isNoise(args)) realWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (!isNoise(args)) realError(...args);
  };
}
