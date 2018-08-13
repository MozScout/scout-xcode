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

// Load the AWS SDK for Node.js
var AWS = require('aws-sdk');
// Set the region
AWS.config.update({ region: process.env.AWS_REGION });

//configure ffmpeg
var ffmpeg = require('fluent-ffmpeg');

// Create an SQS service object
var sqs = new AWS.SQS({ apiVersion: '2012-11-05' });
var queueURL = process.env.SQS_QUEUE;
var sqsParams = {
  AttributeNames: ['SentTimestamp'],
  MaxNumberOfMessages: 1,
  MessageAttributeNames: ['All'],
  QueueUrl: queueURL,
  VisibilityTimeout: 20,
  WaitTimeSeconds: 5
};

/*
 * Main message processing loop.  It receives messages of the
 * filenames it's supposed to transcode.  This should be used
 * when transcoding cannot be done in near realtime.  Right now
 * this just transcodes mp3->opus, but in the future could be
 * modified to handle more.  The target bit rate of the opus
 * codec is an environment variable.  This removes any existing
 * messages from the queue and transcodes them and then goes
 * back into a wait state for more incoming requests
 */
var receiveMessage = async function() {
  sqs.receiveMessage(sqsParams, async function(err, data) {
    logger.debug('receive loop');
    if (err) {
      logger.error(err);
    }
    if (data.Messages) {
      for (var i = 0; i < data.Messages.length; i++) {
        var message = data.Messages[i];
        let jsonBody = JSON.parse(message.Body);
        logger.debug(jsonBody.filename);
        // Check if the file is there already
        if (!(await checkFileExistence(jsonBody.filename))) {
          try {
            transcodeFile(jsonBody).then(function(newFileName) {
              storeFile(newFileName);
            });
          } catch (err) {
            logger.error('Error: ' + err);
          } finally {
            // Always remove from the queue regardless of errors.
            removeFromQueue(message);
          }
        }
      }
      receiveMessage();
    } else {
      logger.debug('No Message');
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
var removeFromQueue = function(message) {
  logger.debug('Removing Message from queue');
  sqs.deleteMessage(
    {
      QueueUrl: queueURL,
      ReceiptHandle: message.ReceiptHandle
    },
    function(err, data) {
      err && logger.error(err);
      logger.error(data);
    }
  );
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
var transcodeFile = function(jsonBody) {
  return new Promise((resolve, reject) => {
    logger.debug('Calling transcodeFile');
    let url =
      'https://s3.amazonaws.com/' +
      process.env.POLLY_S3_BUCKET +
      '/' +
      jsonBody.filename;

    logger.debug('filename: ' + url);
    let outputName = './' + jsonBody.filename.replace('mp3', 'opus');
    logger.debug('new filename: ' + outputName);
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
          logger.debug('Transcoding succeeded !');
          resolve(outputName);
        })
        .run();
    } catch (err) {
      logger.error('error is: ' + err);
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
var storeFile = function(opusFilename) {
  return new Promise((resolve, reject) => {
    var s3 = new AWS.S3({
      apiVersion: '2006-03-01'
    });
    var bucketParams = {
      Bucket: process.env.POLLY_S3_BUCKET,
      Key: '',
      Body: ''
    };

    var fileStream = fs.createReadStream(opusFilename);
    fileStream.on('error', function(err) {
      reject(err);
    });
    bucketParams.Body = fileStream;
    var path = require('path');
    bucketParams.Key = path.basename(opusFilename);

    logger.debug('startupload: ' + Date.now());
    s3.upload(bucketParams, function(err, data) {
      if (err) {
        logger.error('error uploading ' + err + data);
        reject(err);
      } else {
        logger.debug('Successfully uploaded');
        //Don't make the resolution of the promise dependent on
        //deleting the local file just on the off chance we get
        //a duplicate request.
        resolve();
        // Remove the files locally.
        fs.unlink(opusFilename, err => {
          if (err) {
            logger.error('failed to delete file:' + err);
          } else {
            logger.debug('successfully deleted local file');
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
var checkFileExistence = async function(filename) {
  var s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  // checks if that file still exists at s3
  if (filename) {
    let outputName = filename.replace('mp3', 'opus');

    logger.debug(`Checking location for: ${outputName}`);
    logger.debug(process.env.POLLY_S3_BUCKET);
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
      logger.debug('File does not exist: ' + err);
      return false;
    }
  }
  return false;
};

/* start the message loop */
receiveMessage();

module.exports = receiveMessage;
