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
            res.status(204).send('Preflight was good');
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

    // If there is a property of 1 in the queue, there is a user in line
    if (!queue.hasOwnProperty(1)) return;

    const userId = queue[1];
    return completeOrder(userId, caseId)
        .then(() => {
            return sendOrderToKart(db.ref(`caseQueues/${caseId}`), caseId);
        })
        .catch(error => {
            console.error('Check Case Stat', error);
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

    // Get if the case is available
    const isCaseAvailable = (await db.ref(`cases/${caseId}/isAvailable`).once('value')).val();

    // If the case is not available, stop here
    if (!isCaseAvailable) return;

    const queue = snapshot.val();
    if (!queue.hasOwnProperty(1)) return;

    const userId = queue[1];

    return completeOrder(userId, caseId)
        .then(() => {
            return sendOrderToKart(queueRef, caseId);
        })
        .catch(error => {
            console.error('Process Case Order', error);
        });
});

exports.processKartQueue = functions.database.ref('kartQueue/{kartId}').onCreate(async (snapshot, context) => {

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
        .then(snapshot => {
            if (!snapshot.exists()) return null;

            // For each of the case ID, queue the order into the appropriate case queue and return a boolean value
            snapshot.forEach(snap => {
                !!queueUserOrder(uid, snap.key);
            });
        });
}

/**
 * Queue the user based on their userID into the caseQueue by using FIFO method. When a new transaction is created,
 * check if the case is available, if it is, complete the order of the first user. Then push the log of the order
 * been created to the appropriate field then remove the case from the user's cart.
 * @param uid
 * @param caseId
 * @returns {Promise<void | never>}
 */
function queueUserOrder(uid, caseId) {
    const pushKey = db.ref().push().key;
    const userHistory = db.ref(`userHistory/${uid}/${pushKey}`);
    const pastOrderRef = db.ref(`userPastOrders/${uid}/${pushKey}`);
    const cartRef = db.ref(`userCarts/${uid}/${caseId}`);
    const timestamp = admin.database.ServerValue.TIMESTAMP;

    // A nice way to always ensure that there are no duplicate or out of order orders.
    return db.ref(`caseQueues/${caseId}`).transaction(caseData => {
        if (!caseData) caseData = {};

        if (!caseData.queue) caseData.queue = {};
        const position = Object.keys(caseData.queue).length;
        caseData.queue[position + 1] = uid;

        if (!caseData.queueCount) caseData.queueCount = 0;
        caseData.queueCount++;
        return caseData;
    }).then(txData => {
        if (!txData.committed) throw new Error('Unable to add cases to queue.');
        const snap = txData.snapshot;
        let info = 'Order Created! ';
        const queueID = snap.val().queue.uid;

        if (queueID > 1) {
            info += `You are #${queueID} in the queue`;
        } else {
            info += `Your order has been processed.`;
        }

        return userHistory.set({
            timestamp: admin.database.ServerValue.TIMESTAMP,
            info: info,
            caseId: caseId
        });
    }).then(() => {
        return pastOrderRef.set({
            case: caseId,
            timestamp: timestamp,
            completed: false
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
function completeOrder(uid, caseId) {
    const pushKey = db.ref().push().key;
    const completeOrderRef = db.ref(`completeOrders/${caseId}/${pushKey}`);
    const pastOrderRef = db.ref(`userPastOrders/${uid}/${pushKey}`);
    const caseRef = db.ref(`cases/${caseId}`);
    const userHistory = db.ref(`userHistory/${uid}/${pushKey}`);
    const timestamp = admin.database.ServerValue.TIMESTAMP;

    // Add to complete order table, user's past orders and update the case availability.
    return completeOrderRef.set({
        user: uid,
        timestamp: timestamp,
        scanned: false
    })
        .then(() => pastOrderRef.update({
            case: caseId,
            timestamp: timestamp,
            completed: false
        }))
        .then(() => caseRef.update({
            isAvailable: false
        }))
        .then(() => userHistory.set({
            timestamp: timestamp,
            info: 'Your order has been completed!',
            caseId: caseId
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
 * @returns {Promise<T>}
 */
function sendOrderToKart(queueRef, caseId) {
    let nextUserId = null;
    const kartQueueRef = db.ref(`kartQueues`);
    const kartInfoRef = db.ref(`kartInfo`);
    const caseInfoRef = db.ref(`cases/${caseId}`);
    const userHistory = db.ref(`userHistory/`);
    const timestamp = admin.database.ServerValue.TIMESTAMP;

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
        const caseLastLocation = (await caseInfoRef.child('lastLocation').once('value')).val();
        // Order the karts in descending order from A1 to C3
        const orderedKartRef = kartInfoRef.orderByChild('currentLocation');
        let bestKart = null;

        // check if the kart is in the same location as the case
        let currentKartLoc = (await orderedKartRef.equalTo(caseLastLocation).once('value')).val();
        console.log('Kart at location', currentKartLoc);

        // If there is no kart at to the case location, check for next closest
        if (!currentKartLoc) {
            let shortestDistance = Number.MAX_SAFE_INTEGER; // Default to Max Integer
            const allKarts = (await orderedKartRef.once('value'));
            allKarts.forEach(kartSnap => {
                const kartLoc = kartSnap.val()['currentLocation'];
                const curDist = shortestGridDist(currentKartLoc, kartLoc);
                // If the distance of the kart is less than the most recent short distance
                // Save the kart as the best kart and continue
                // Maybe for optimization, if the curDist is 1, then it's in the shortest possible dist
                if (curDist < shortestDistance) {
                    bestKart = kartSnap.key;
                    shortestDistance = curDist;
                }
            });
        } else {
            bestKart = currentKartLoc['currentLocation'];
        }
        console.log('Best Kart: ', bestKart);
        // After moving the queue up, add the nextUserId and the caseId to the kartQueue
        return kartQueueRef.child(bestKart).push({
            userId: nextUserId,
            caseId: caseId
        });
    }).then(() => {
        if (!nextUserId) return;
        return userHistory.child(nextUserId).push({
            case: caseId,
            timestamp: timestamp,
            info: 'Your order has been sent to a kart for processing'
        });
    });
}

/**
 * Calculate the distance between two coordinate points using the quadratic formula
 * @param a
 * @param b
 * @returns {string}
 */
function shortestGridDist(a, b) {
    const x1 = a.x;
    const x2 = b.x;
    const y1 = a.y;
    const y2 = b.y;
    const dis = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    return dis.toFixed(2);
}