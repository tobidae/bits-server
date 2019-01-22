const functions = require('firebase-functions');
const admin = require('firebase-admin');
var cors = require('cors');

cors = cors({
    origin: true
});

admin.initializeApp();
const db = admin.database();

const validateFirebaseIdToken = (req, res) => {
    return new Promise((resolve, reject) => {
        if ((!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) &&
            !req.cookies.__session) {
            console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.');
            reject('Unauthorized');
        }

        let idToken;
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
            idToken = req.headers.authorization.split('Bearer ')[1];
        } else {
            idToken = req.cookies.__session;
        }
        admin.auth().verifyIdToken(idToken)
            .then(decodedIdToken => {
                resolve(decodedIdToken);
            }).catch(error => {
            console.error('Error while verifying Firebase ID token ', error);
            reject('Unauthorized');
        });
    })
};

//
exports.placeCaseOrder = functions.https.onRequest((req, res) => {
    if ('OPTIONS' == req.method && req.body == null) {
        res.status(204).send('Preflight was good');
    }
    cors(req, res, () => {
        validateFirebaseIdToken(req, res)
            .then(user => {
                let userId = user['uid'];
                // let bodyData = req.body;

                addOrderToQueue(userId);
            });
    });

    function addOrderToQueue(uid) {
        db.ref(`userCarts/${uid}`).once('value')
            .then(snapshot => {
                if (!snapshot.exists()) return null;

                // For each of the case ID, add it to the appropriate case queue
                snapshot.forEach(snap => {
                    console.log('Each cart id', snap.key);
                    // A nice way to always ensure that there are no duplicate or out of order orders.
                    db.ref(`caseQueues/${snap.key}`).transaction(caseData => {
                        if (caseData) {
                            if (!caseData.queue) caseData.queue = {};
                            caseData.queue[uid] = true;

                            if (!caseData.queueCount) caseData.queueCount = 0;
                            caseData.queueCount++;
                        }
                        return caseData;
                    })

                });
            })
    }
});
