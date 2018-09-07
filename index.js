/*
 * index.js
 *
 * Logic to remove messages from the SQS queue and transcode the 
 * files to the requested format using ffmpeg.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const logger = require('./logger');
const fs = require('fs');
const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const SqsQueue = require('./SqsQueue');
require('dotenv').config();

// Set up SQS & queues
AWS.config.update({ region: process.env.AWS_REGION });
const sqs = new AWS.SQS({ apiVersion: '2012-11-05' });
const messageQueueURL = process.env.SQS_QUEUE;
const sqsParams = {
  AttributeNames: ['SentTimestamp'],
  MaxNumberOfMessages: 1,
  MessageAttributeNames: ['All'],
  QueueUrl: messageQueueURL,
  VisibilityTimeout: 20,
  WaitTimeSeconds: 5
};

const failureQueueURL = process.env.SQS_FAILURE_QUEUE;
const failQueue = new SqsQueue(failureQueueURL, 'scout');

/*
 * Main message processing loop.  It receives messages of the
 * filenames it's supposed to transcode.  This should be used
 * when transcoding cannot be done in near realtime.  Right now
 * this just transcodes mp3->opus, but in the future could be
 * modified to handle more.  The target bit rate of the opus
 * codec is an environment variable.  This removes any existing
 * messages from the queue and transcodes them and then goes
 * back into a wait state for more incoming requests. 
 * If there is an error in message processing, the message is 
 * left in the queue for retry.
 */
const receiveMessage = () => {
  sqs.receiveMessage(sqsParams, async function(err, data) {
    logger.debug('.');
    if (err) {
      logger.error(err);
    }
    if (data && data.Messages) {
      data.Messages.forEach(async message => {
        // validate message format
        let jsonBody;
        try {
          jsonBody = JSON.parse(message.Body);
          if (!jsonBody.filename) {
            throw `Expected "filename" value in message `;
          }
        } catch (err) {
          logger.error(`Message format err: ${err}`);
          handleMessageFailure(message, err);
        }

        // create transcode request if the file doesn't already exist
        logger.info(`Received message with filename: ${jsonBody.filename}`);
        if (jsonBody && jsonBody.filename) {
          const fileExists = await checkFileExistence(jsonBody.filename);
          if (!fileExists) {
            transcodeFile(jsonBody.filename)
              .then(newFileName => {
                storeFile(newFileName);
              })
              .catch(err => {
                const errString = `Transcoding error: ${err}`;
                handleMessageFailure(message, errString);
              });
          }
        }

        removeFromMessageQueue(message);
      });

      receiveMessage();
    } else {
      setTimeout(function() {
        receiveMessage();
      }, 0);
    }
  });
};

/*
 * Removes message from the queue
 * 
 * params: The message to be removed
 */
const removeFromMessageQueue = function(message) {
  sqs.deleteMessage(
    {
      QueueUrl: messageQueueURL,
      ReceiptHandle: message.ReceiptHandle
    },
    function(err) {
      if (err) {
        const errString = `removeFromMessageQueue error: ${err}`;
        logger.error(errString);
        handleMessageFailure(message, errString);
      }
    }
  );
};

const handleMessageFailure = (message, error) => {
  const failureInfo = {
    message,
    error: error ? error.toString() : 'unknown'
  };
  logger.error(`Failed message: ${failureInfo.error}`);
  if (failureQueueURL) {
    failQueue.add(failureInfo);
  }
};

/*
 * This function transcodes from one format to another.
 * As a side effect it creates the new filename of the transcoded
 * file.
 * 
 * params: JSON body of the name of the file in the bucket which
 *  may contain other transcoding params in the future.
 * returns: 
 *  promise:
 *    resolve - able to transcode
 *    reject - could not process the audio
 */
const transcodeFile = function(filename) {
  return new Promise((resolve, reject) => {
    let url =
      'https://s3.amazonaws.com/' +
      process.env.POLLY_S3_BUCKET +
      '/' +
      filename;

    let outputName = './' + filename.replace('mp3', 'opus');
    logger.debug(`Launching transcode process =>
      from: ${url} 
      to:   ${outputName}`);
    try {
      ffmpeg(url)
        .outputOptions([
          '-c:a libopus',
          '-b:a ' + (process.env.OPUS_BIT_RATE || '24000'),
          '-vbr on',
          '-compression_level 10'
        ])
        .output(outputName)
        .on('error', function(err) {
          logger.error('Cannot process audio: ' + err.message);
          reject(err);
        })
        .on('end', function() {
          logger.info(`Transcoding succeeded for ${outputName}`);
          resolve(outputName);
        })
        .run();
    } catch (err) {
      logger.error('Transcode error: ' + err);
      reject(err);
    }
  });
};

/*
 * This function stores the transcoded file in the bucket
 * bucket.
 * params: filename - name of the file we are looking for
 * returns: 
 *  promise
 *    resolved - file was uploaded
 *    rejected - unable to upload
 */
const storeFile = function(opusFilename) {
  logger.debug(`storeFile: ${opusFilename}`);
  return new Promise((resolve, reject) => {
    const s3 = new AWS.S3({
      apiVersion: '2006-03-01'
    });
    const bucketParams = {
      Bucket: process.env.POLLY_S3_BUCKET,
      Key: '',
      Body: ''
    };

    const fileStream = fs.createReadStream(opusFilename);
    fileStream.on('error', function(err) {
      reject(err);
    });
    bucketParams.Body = fileStream;
    const path = require('path');
    bucketParams.Key = path.basename(opusFilename);

    logger.debug(`startupload of ${opusFilename}: ${Date.now()}`);
    s3.upload(bucketParams, function(err, data) {
      if (err) {
        logger.error(
          `Error uploading ${opusFilename}, err=${err}, data=${data}`
        );
        reject(err);
      } else {
        logger.debug(`Successfully uploaded ${opusFilename}`);
        //Don't make the resolution of the promise dependent on
        //deleting the local file just on the off chance we get
        //a duplicate request.
        resolve();
        // Remove the files locally.
        fs.unlink(opusFilename, err => {
          if (err) {
            logger.error(`failed to delete file ${opusFilename}: ${err}`);
          } else {
            logger.debug(`Successfully deleted local file ${opusFilename}`);
          }
        });
      }
    });
  });
};

/*
 * This function checks to see if the file already exists in the
 * bucket so we don't transcode unnecessarily.
 * params: filename - name of the file we are looking for
 * returns: 
 *  true - file exists
 *  false - does not exist
 */
const checkFileExistence = async function(filename) {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  // checks if that file still exists at s3
  if (filename) {
    let outputName = filename.replace('mp3', 'opus');

    logger.debug(
      `Checking ${process.env.POLLY_S3_BUCKET} bucket for: ${outputName}`
    );
    const params = {
      Bucket: process.env.POLLY_S3_BUCKET,
      Key: outputName
    };

    try {
      const s3request = s3.headObject(params);
      await s3request.promise();
      logger.debug('Verified existing file');
      return true;
    } catch (err) {
      logger.debug('File does not exist.');
      return false;
    }
  }
  return false;
};

/* start the message loop */
logger.debug(`Message queue: ${messageQueueURL}`);
logger.debug(`Failure queue: ${failureQueueURL}`);
if (!messageQueueURL) {
  logger.error(`Message queue URL missing. Cannot initialize mesage queue.`);
} else {
  if (!failureQueueURL) {
    logger.warn(`Failure queue URL missing. Failed events will be discarded.`);
  }
  logger.info('Starting message loop...');
  receiveMessage();
}
