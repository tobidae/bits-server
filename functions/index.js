const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({
    origin: true
});
const factorySectors = {
    'A1': {x: 0, y: 0}, 'A2': {x: 1, y: 0}, 'A3': {x: 2, y: 0},
    'B1': {x: 0, y: 1}, 'B2': {x: 1, y: 1}, 'B3': {x: 2, y: 1},
    'C1': {x: 0, y: 2}, 'C2': {x: 1, y: 2}, 'C3': {x: 2, y: 2}
};

admin.initializeApp();
const db = admin.database();
const messaging = admin.messaging();

const validateFirebaseIdToken = (req, res) => {
    return new Promise((resolve, reject) => {
        if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
            console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.');
            reject('Unauthorized');
        }

        let idToken;
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
            idToken = req.headers.authorization.split('Bearer ')[1];
        }

        if (!idToken) reject('Unauthorized');
        admin.auth().verifyIdToken(idToken)
            .then(decodedIdToken => {
                resolve(decodedIdToken);
            }).catch(error => {
            console.error('Error while verifying Firebase ID token ', error);
            reject('Unauthorized');
        });
    })
};

/**
 * Order is created by passing in the userID to the create order function
 * @type {HttpsFunction}
 */
exports.placeCaseOrder = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        if (req.method === 'OPTIONS' && req.body == null) {
            res.status(204).send('Pre-flight was good');
        }
        validateFirebaseIdToken(req, res).then(user => {
            let userId = user['uid'];
            // let bodyData = req.body;

            createOrder(userId).then(() => {
                res.status(200).send({
                    type: 'success',
                    message: 'Added order to queue'
                })
            }).catch(error => {
                console.log(error);
                res.status(400).send({
                    type: 'error',
                    message: error
                });
            });
        }).catch(error => {
            res.status(401).send({
                type: 'error',
                message: error
            })
        });
    });
});

/**
 * Anytime the status of a case changes to available, check the caseQueue to see if any user currently needs the device
 * If a user needs the device, then complete the order for that user. After that, push the queue up one by transaction
 * TODO: Send notification of the order been completed
 * @type {CloudFunction<Change<DataSnapshot>>}
 */
exports.checkCaseStatus = functions.database.ref('cases/{caseId}/isAvailable').onUpdate(async (snapshot, context) => {
    const isCaseAvailable = snapshot.after.val();
    const caseId = context.params['caseId'];

    // If the case is available and there is queue data, work with the queue data object
    if (!isCaseAvailable) return;

    // Get the queue ref
    const queue = (await db.ref(`caseQueues/${caseId}/queue`).once('value')).val();
    const caseInfo = (await db.ref(`cases/${caseId}`).once('value')).val();

    // If there is a property of 1 in the queue, there is a user in line
    if (!queue || !queue.hasOwnProperty(1)) return;

    const userId = queue[1].userId;
    const pushKey = queue[1].pushKey;
    const pickupLocation = queue[1].pickupLocation;

    const caseName = caseInfo['name'];
    const payload = {
        notification: {
            title: 'Your order was processed ',
            body: `Your order for ${caseName} is ready to be shipped, hang tight!`
        }
    };

    return fulfillOrder(userId, caseId, pushKey)
        .then(() => sendMessageToUser(userId, payload))
        .then(() => sendOrderToKart(db.ref(`caseQueues/${caseId}`), caseId, pushKey, pickupLocation))
        .catch(error => {
            console.error('Check Case stat', error);
        });
});

/**
 * When a user is added to the caseQueue, check if the case isAvailable. If it is, push the caseId and userId to the
 * kartQueue.
 * @type {CloudFunction<DataSnapshot>}
 */
exports.processCaseOrder = functions.database.ref('caseQueues/{caseId}/queue').onCreate(async (snapshot, context) => {
    const queueRef = snapshot.ref.parent;
    const caseId = context.params['caseId'];
    const caseInfo = (await db.ref(`cases/${caseId}`).once('value')).val();

    // Get if the case is available
    const isCaseAvailable = caseInfo['isAvailable'];

    // If the case is not available, stop here
    if (!isCaseAvailable) return;

    const queue = snapshot.val();
    if (!queue || !queue.hasOwnProperty(1)) return;

    const userId = queue[1].userId;
    const pushKey = queue[1].pushKey;
    const pickupLocation = queue[1].pickupLocation;

    const caseName = caseInfo['name'];
    const payload = {
        notification: {
            title: 'Your order was processed ',
            body: `Your order for ${caseName} is ready to be shipped, hang tight!`,
            icon: caseInfo.imageUrl
        }
    };

    return fulfillOrder(userId, caseId, pushKey)
        .then(() => sendMessageToUser(userId, payload))
        .then(() => sendOrderToKart(queueRef, caseId, pushKey, pickupLocation))
        .catch(error => {
            console.error('Process Case Order', error);
        });
});

exports.processKartQueue = functions.database.ref('kartQueues/{kartId}').onCreate(async (snapshot, context) => {

});


/**
 * This function creates an order for each case in a user's cart. The function adds each of the cases into the
 * queues for each of the cases.
 * @param uid
 * @returns {Promise<admin.database.DataSnapshot | null>}
 */
function createOrder(uid) {
    const cartRef = db.ref(`userCarts/${uid}`);

    // Get the snapshot of the user's cart
    return cartRef.once('value')
        .then(async snapshot => {
            if (!snapshot.exists()) return null;

            const userLocation = (await db.ref(`userInfo/${uid}/pickupLocation`).once('value')).val();
            // For each of the case ID, queue the order into the appropriate case queue and return a boolean value
            snapshot.forEach(snap => {
                !!queueUserOrder(uid, snap.key, userLocation);
            });
        })
        .catch(error => {
            console.error('Create Case Order', error);
        });
}

/**
 * Queue the user based on their userID into the caseQueue by using FIFO method. When a new transaction is created,
 * check if the case is available, if it is, complete the order of the first user. Then push the log of the order
 * been created to the appropriate field then remove the case from the user's cart.
 * @param uid
 * @param caseId
 * @param userLocation
 *
 */
function queueUserOrder(uid, caseId, userLocation) {
    const pushKey = db.ref().push().key;
    const userHistory = db.ref(`userHistory/${uid}/${pushKey}`);
    const cartRef = db.ref(`userCarts/${uid}/${caseId}`);
    const timestamp = admin.database.ServerValue.TIMESTAMP;

    // A nice way to always ensure that there are no duplicate or out of order orders.
    return db.ref(`caseQueues/${caseId}`).transaction(caseData => {
        if (!caseData) caseData = {};

        if (!caseData.queue) caseData.queue = {};
        const position = Object.keys(caseData.queue).length;
        caseData.queue[position + 1] = {
            userId: uid,
            pushKey: pushKey,
            pickupLocation: userLocation,
            timestamp: timestamp
        };

        if (!caseData.queueCount) caseData.queueCount = 0;
        caseData.queueCount++;
        return caseData;
    }).then(txData => {
        if (!txData.committed) throw new Error('Unable to add cases to queue.');
        const snap = txData.snapshot;
        const queueCount = snap.val().queueCount;

        const info = `Order Created! You are #${queueCount} in the queue`;

        return userHistory.set({
            timestamp: admin.database.ServerValue.TIMESTAMP,
            info: info,
            caseId: caseId,
            type: queueCount > 1 ? 'in-queue' : 'order-processed',
            queueCount: queueCount
        });
    }).then(() => {
        return cartRef.remove();
    }).catch(error => {
        throw new Error(error);
    });
}

/**
 * This function is triggered when the order has been completed. The order hasn't necessarily been fulfilled but it
 * should be on its way to fulfillment.
 * @param uid
 * @param caseId
 */
function fulfillOrder(uid, caseId, pushKey) {
    const pastOrderRef = db.ref(`userPastOrders/${uid}/${pushKey}`);
    const caseRef = db.ref(`cases/${caseId}`);
    const timestamp = admin.database.ServerValue.TIMESTAMP;

    // Add to complete order table, user's past orders and update the case availability.
    return pastOrderRef.update({
        caseId: caseId,
        fulfillTimestamp: timestamp,
        orderFulfilled: true,
        kartReceivedOrder: false,
        completedByKart: false,
        scannedByUser: false
    })
        .then(() => caseRef.update({
            isAvailable: false
        }))
        .catch(error => {
            console.error('Complete Order', error);
        });
}

/**
 * Get the user and caseId and determine the closest kart to the lastLocation of the case. If the case is not close to
 * kart, get the next closest kart and send the order to the kart. The snippet sent includes the userId and caseId
 * @param queueRef
 * @param caseId
 * @param pushKey
 */
async function sendOrderToKart(queueRef, caseId, pushKey, pickupLocation) {
    let nextUserId = null;
    const kartQueueRef = db.ref(`kartQueues`);
    const kartInfoRef = db.ref(`kartInfo`);
    const caseInfoRef = db.ref(`cases/${caseId}`);
    const userHistory = db.ref(`userHistory`);
    const timestamp = admin.database.ServerValue.TIMESTAMP;
    const caseInfo = (await caseInfoRef.once('value')).val();

    let bestKart = null;
    let kartLoc = null;

    // Remove the first user in the queue and move the queue up then set the userId to first user
    return queueRef.transaction(queueData => {
        if (!queueData) return queueData;

        const queueLength = Object.keys(queueData.queue).length;
        if (queueLength > 0 && !nextUserId) {
            nextUserId = queueData.queue[1].userId;
        }
        for (let i = 1; i < queueLength; i++) {
            queueData.queue[i] = queueData.queue[i + 1];
        }
        // Remove the last entry in the queue since queue has been pushed up
        delete queueData.queue[queueLength];
        queueData.queueCount--;
        return queueData;
    }).then(async txData => {
        if (!txData.committed) throw new Error('Unable to move queue');

        // Get the last location of a case
        const caseLastLocation = caseInfo['lastLocation'];
        // Order the karts in descending order from A1 to C3
        const orderedKartRef = kartInfoRef.orderByChild('currentLocation');

        // check if the kart is in the same location as the case
        let currentKartRef = (await orderedKartRef.equalTo(caseLastLocation).once('value'));
        let currentKartData = currentKartRef.val();

        // If there is no kart at to the case location, check for next closest
        if (!currentKartData) {
            let shortestDistance = Number.MAX_SAFE_INTEGER; // Default to Max Integer
            const allKarts = (await orderedKartRef.once('value'));
            allKarts.forEach(kartSnap => {
                const curDist = shortestGridDist(caseLastLocation, kartLoc);
                // If the distance of the kart is less than the most recent short distance
                // Save the kart as the best kart and continue
                // Maybe for optimization, if the curDist is 1, then it's in the shortest possible dist
                if (curDist < shortestDistance) {
                    bestKart = kartSnap.key;
                    kartLoc = kartSnap.val()['currentLocation'];
                    shortestDistance = curDist;
                }
            });
        } else {
            // Since there is a kart at the case location, the case location and best cart can be set here
            bestKart = Object.keys(currentKartData)[0];
            kartLoc = caseLastLocation;
        }
        console.log(`[INFO] Location: Case - ${caseLastLocation}, Kart - ${kartLoc}`);
        console.log('[INFO] Best Kart:', bestKart);

        if (!bestKart) throw new Error('Karts are not available at this time.');

        // After moving the queue up, add the nextUserId and the caseId to the kartQueue
        return kartQueueRef.child(bestKart).child(pushKey).set({
            userId: nextUserId,
            caseId: caseId,
            pushKey: pushKey,
            pickupLocation: pickupLocation
        });
    }).then(async () => {
        const payload = {
            notification: {
                title: 'Your order was sent to a kart',
                body: `Your order for ${caseInfo['name']} was sent to kart ${bestKart}!`
            }
        };
        return sendMessageToUser(nextUserId, payload);
    }).then(() => {
        if (!nextUserId) return;
        return userHistory.child(nextUserId).push({
            caseId: caseId,
            timestamp: timestamp,
            info: 'Your order was sent to a kart for processing',
            type: 'kart-processing'
        });
    });
}

/**
 * Calculate the distance between two coordinate points using the quadratic formula
 * @param a
 * @param b
 * @returns {number}
 */
function shortestGridDist(a, b) {
    a = factorySectors[a];
    b = factorySectors[b];
    if (a == null || b == null) {
        console.log('[DEBUG-INFO] Value of A', a, 'Value of b', b);
        return 1;
    }
    const x1 = a.x;
    const x2 = b.x;
    const y1 = a.y;
    const y2 = b.y;
    const dis = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    return Number(dis.toFixed(2)).valueOf();
}

async function sendMessageToUser(userId, payload) {
    const userToken = (await db.ref(`userInfo/${userId}/notificationToken`).once('value')).val();
    if (!userToken) return;
    return messaging.sendToDevice(userToken, payload, {
        priority: 'high'
    });
}