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
  async fetch(request) {
    const destinationURL = "https://github.com/tweedge/workers-email-archiver";
    const statusCode = 307;
    return Response.redirect(destinationURL, statusCode);
  },

  async email(message, env, ctx) {
    // fetch context
    let timeNow = Date.now();
    var rawEmail = await streamToArrayBuffer(message.raw, message.rawSize);

    // compress
    const compressedEmail = gzipSync(rawEmail, {
      // GZIP-specific: the filename and time to use when decompressed
      filename: `${timeNow}.eml`,
      mtime: timeNow,
      level: 9
    });

    // kill the original since we're memory-constrained
    rawEmail = new Uint8Array(1);

    // get the recipient domain (used as top level folder)
    const emailDstSplit = message.to.split('@');
    const domain = emailDstSplit[1];

    // and the source domain (used as bottom level folder)
    const emailSrcSplit = message.from.split('@');
    const srcDomain = emailSrcSplit[1];

    // set up to PUT object in S3
    const aws = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY,     
      secretAccessKey: env.S3_ACCESS_SECRET,
      service: "s3",
      region: env.S3_REGION,
    });

    const endpoint = `https://${env.S3_BUCKET}.${env.S3_ENDPOINT}/`;

    // save it
    const filename = `${domain}/${message.to}/${srcDomain}/${timeNow}.eml.gz`.toLowerCase();
    const res = await aws.fetch(`${endpoint}${filename}`, {
      method: 'PUT',
      body: compressedEmail,
    }).then(function(response) {
      if (!response.ok) {
        // fuck!
        throw new Error(`Bad status code from ${endpoint}: ${response.status}`);
      } else {
        // you done it! *crayon star*
        console.log(`Archived ${filename}`);
      }
    })
  }
}