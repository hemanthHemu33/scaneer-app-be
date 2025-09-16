if (!process.env.TZ) {
  process.env.TZ = "Asia/Kolkata";
}

export const TIMEZONE = process.env.TZ;
