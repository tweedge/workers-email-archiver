import { AwsClient } from 'aws4fetch';
import { gzipSync } from 'fflate';


async function streamToArrayBuffer(stream, streamSize) {
  let result = new Uint8Array(streamSize);
  let bytesRead = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    result.set(value, bytesRead);
    bytesRead += value.length;
  }
  return result;
}

export default {
  async email(message, env, ctx) {
    // fetch context
    console.log(`Processing email from ${message.from} to ${message.to}`);
    let timeNow = Date.now();
    const rawEmail = await streamToArrayBuffer(message.raw, message.rawSize);

    // compress
    const compressedEmail = gzipSync(rawEmail, {
      // GZIP-specific: the filename and time to use when decompressed
      filename: `${timeNow}.eml`,
      mtime: timeNow,
      level: 9
    });

    // get the domain (used as top level folder)
    const emailDstSplit = message.to.split('@');
    const domain = emailDstSplit[1];

    // set up to PUT object in S3
    const aws = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY,     
      secretAccessKey: env.S3_ACCESS_SECRET,
      service: "s3"
    });

    const endpoint = `https://${env.S3_BUCKET}.${env.S3_ENDPOINT}/`;

    // save it
    const filename = `${domain}/${message.to}/${message.from}/${timeNow}.eml.gz`.toLowerCase();
    const res = await aws.fetch(`${endpoint}${filename}`, {
      method: 'PUT',
      body: compressedEmail,
    });
    console.log(`Compressed and saved email as ${timeNow}.eml.gz`);
  }
}