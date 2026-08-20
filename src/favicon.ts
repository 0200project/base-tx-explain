/** 32x32 favicon (PNG), embedded so it needs no build-time asset copy. */
const BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA0klEQVR4nGPk5hX4zzCAgGkgLR91wKAIARZcEl9d3+PUxL1bkGoO' +
  'YMSWC/BZjs0Rd+/eJdpCZWVl6kbBXRIsx6aeiWGAAdOQd4AyWpySqp6FUgeQ44jBHwXcBPI5zcsBUkH/tLl45QuzkmkXBf0ELCek' +
  'holhgAELLgl5JTWcmh7eu0U1BzCRajm6PL74JUYNI7ZESMgB1AwFJqqYMpQdwEINQwIjk1D465fPo18IBKJZjkuMZg6gFDCRk8Kp' +
  'WQ4wUqMuoCQNMI52zRgGGDCNeAcAAKvSNVwyO3wVAAAAAElFTkSuQmCC';

export const FAVICON_PNG = Buffer.from(BASE64, 'base64');
