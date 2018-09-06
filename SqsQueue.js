/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
var uuidgen = require('node-uuid-generator');
var AWS = require('aws-sdk');
require('dotenv').config();

// Create an SQS service object
AWS.config.update({ region: process.env.AWS_REGION });
var sqs = new AWS.SQS({ apiVersion: '2012-11-05' });

class SqsQueue {
  constructor(queueUrl, messageGroupId) {
    this.url = queueUrl;
    this.groupId = messageGroupId;
  }

  add(messageObj) {
    return new Promise((resolve, reject) => {
      const params = {
        MessageAttributes: {},
        MessageGroupId: this.groupId,
        MessageDeduplicationId: uuidgen.generate(),
        MessageBody: JSON.stringify(messageObj),
        QueueUrl: this.url
      };

      sqs.sendMessage(params, function(err) {
        if (err) {
          reject('SQS send error', err);
        }
        resolve();
      });
    });
  }
}

module.exports = SqsQueue;
