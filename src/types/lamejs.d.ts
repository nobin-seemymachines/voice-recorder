declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, bitRate: number);
    encodeBuffer(left: Int16Array, right: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  const lamejs: any;
  export default lamejs;
}
