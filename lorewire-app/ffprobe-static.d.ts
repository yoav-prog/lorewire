// ffprobe-static ships no type definitions and no companion @types package
// exists on the registry. The runtime API is a single field: `path` is the
// absolute filesystem path to the bundled ffprobe binary for the host
// platform. Declared here so `import ffprobeStatic from "ffprobe-static"`
// type-checks under our strict tsconfig.

declare module "ffprobe-static" {
  interface FfprobeStatic {
    path: string;
  }
  const ffprobeStatic: FfprobeStatic;
  export default ffprobeStatic;
}
