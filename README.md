# scout-xcode

Message queue based transcoding of audio files

## Installing on AWS Ubuntu

This link describes the basic node setup on AWS ubuntu: https://hackernoon.com/tutorial-creating-and-managing-a-node-js-server-on-aws-part-1-d67367ac5171

## Installing ffmpeg

This link has a good description of how to install ffmpeg on both ubuntu and debian AWS instances: https://gist.github.com/jmsaavedra/62bbcd20d40bcddf27ac

## Environment variables

```
AWS_REGION=us-east-1  // Use the same region as the scout-ua server
OPUS_BIT_RATE=24000
POLLY_S3_BUCKET=      // Must match the POLLY_S3_BUCKET value used by the scout-ua server
SQS_QUEUE=            // The full URL of the SQS FIFO message queue where scout-ua sends transcode requests
SQS_FAILURE_QUEUE     // (optional) Full URL of an SQS FIFO queue where failed messages
                      // are stored for later retry or review
```
