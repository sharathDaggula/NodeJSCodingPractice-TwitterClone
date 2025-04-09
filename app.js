const express = require('express')
const path = require('path')
const {open} = require('sqlite')
const sqlite3 = require('sqlite3')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

const app = express()
app.use(express.json())

const dbPath = path.join(__dirname, 'twitterClone.db')
let db = null

const initializeDBAndServer = async () => {
  try {
    //initializing database
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    })

    //initializing server
    app.listen(3000, () => {
      console.log('Server Running at http://localhost:3000...')
    })
  } catch (e) {
    console.log(`DB Error: ${e.message}`)
    process.exit(1)
  }
}

initializeDBAndServer()

// middleware function that verifies user

const authenticateToken = (request, response, next) => {
  let jwtToken
  const authHeader = request.headers['authorization']
  if (authHeader !== undefined) {
    jwtToken = authHeader.split(' ')[1]
  }
  if (jwtToken === undefined) {
    response.status(401)
    response.send('Invalid JWT Token')
    return
  } else {
    jwt.verify(jwtToken, 'my_secret_key', async (error, payload) => {
      if (error) {
        response.status(401)
        response.send('Invalid JWT Token')
        return
      } else {
        request.user = {user_id: payload.user_id}
        next()
      }
    })
  }
}

// API 1 -- Registering a new user if doesn't exist in user table

app.post('/register/', async (request, response) => {
  const {username, password, name, gender} = request.body

  try {
    const getUserQuery = `
    SELECT * FROM user WHERE username = '${username}';`

    const dbUser = await db.get(getUserQuery)

    if (dbUser === undefined) {
      if (password.length < 6) {
        response.status(400)
        response.send('Password is too short')
        return
      } else {
        // encrypting the password
        const hashedPassword = await bcrypt.hash(password, 10)
        // query to create a user
        const createUserQuery = `
        INSERT INTO user (username, password, name, gender)
        VALUES ('${username}', '${hashedPassword}', '${name}', '${gender}');`
        await db.run(createUserQuery)
        response.status(200)
        response.send('User created successfully')
        return
      }
    } else {
      response.status(400)
      response.send('User already exists')
      return
    }
  } catch (e) {
    console.log('Internal Server Error: ' + e)
  }
})

//API 2 -- Logging in a user (twitter) based on his account id and pass

app.post('/login/', async (request, response) => {
  const {username, password} = request.body
  const selectUserQuery = `
  SELECT * FROM user WHERE username = '${username}';`
  const dbUser = await db.get(selectUserQuery)
  if (dbUser === undefined) {
    response.status(400)
    response.send('Invalid user')
  } else {
    const isPasswordMatched = await bcrypt.compare(password, dbUser.password)
    if (isPasswordMatched) {
      const payload = {
        username: username,
        user_id: dbUser.user_id,
      }
      const jwtToken = jwt.sign(payload, 'my_secret_key')
      response.send({jwtToken: jwtToken})
    } else {
      response.status(400)
      response.send('Invalid password')
    }
  }
})

// API 3 -- Returning the latest tweets of people whom the user follows. (Returning 4 tweets at a time)
app.get('/user/tweets/feed/', authenticateToken, async (request, response) => {
  const userId = request.user.user_id
  try {
    const getTweetsQuery = `
        SELECT u.username AS username,t.tweet AS tweet, t.date_time AS dateTime
        FROM tweet t
        INNER JOIN follower f ON t.user_id = f.following_user_id
        INNER JOIN user u ON t.user_id = u.user_id
        WHERE f.follower_user_id = ${userId}
        ORDER BY t.date_time DESC
        LIMIT 4;`
    const dbUser = await db.all(getTweetsQuery)
    response.send(dbUser)
  } catch (e) {
    console.log('Internal server error: ' + e)
  }
})

// API 4 -- Returnning the list of all names of people whom the user follows
app.get('/user/following/', authenticateToken, async (request, response) => {
  const userId = request.user.user_id
  try {
    const getFollowingNamesQuery = `
    SELECT u.name AS name
    FROM user u
    INNER JOIN follower f
    ON u.user_id = f.following_user_id
    WHERE f.follower_user_id = ${userId}
    GROUP BY u.user_id;`
    const result = await db.all(getFollowingNamesQuery)
    response.send(result)
  } catch (e) {
    console.log('Internal server error: ' + e)
  }
})

// API 5 -- Returns the list of all names of people who follows the user
app.get('/user/followers/', authenticateToken, async (request, response) => {
  const userId = request.user.user_id
  try {
    const getFollowingNamesQuery = `
    SELECT u.name
    FROM user u
    INNER JOIN follower f
    ON u.user_id = f.follower_user_id
    WHERE f.following_user_id = ${userId}`
    const result = await db.all(getFollowingNamesQuery)
    response.send(result)
  } catch (e) {
    console.log('Internal server error: ' + e)
  }
})

// API 6 -- If the user requests a tweet of the user he is following, return the tweet, likes count, replies count and date-time
app.get('/tweets/:tweetId/', authenticateToken, async (request, response) => {
  const {tweetId} = request.params
  const userId = request.user.user_id
  try {
    // Check if the tweet belongs to a user that the logged-in user follows
    const checkFollowingQuery = `
      SELECT user.user_id
      FROM tweet 
      INNER JOIN user ON tweet.user_id = user.user_id
      INNER JOIN follower ON user.user_id = follower.following_user_id
      WHERE tweet.tweet_id = ${tweetId} AND follower.follower_user_id = ${userId}
    `
    const tweetAuthor = await db.get(checkFollowingQuery)

    if (!tweetAuthor) {
      response.status(401).send('Invalid Request')
      return
    }

    // Fetch tweet details, likes count, replies count, and date-time
    const tweetDetailsQuery = `
      SELECT tweet.tweet, 
             (SELECT COUNT(*) FROM like WHERE tweet_id = ${tweetId}) AS likes,
             (SELECT COUNT(*) FROM reply WHERE tweet_id = ${tweetId}) AS replies,
             tweet.date_time AS dateTime
      FROM tweet
      WHERE tweet.tweet_id = ${tweetId}
    `
    const tweetDetails = await db.get(tweetDetailsQuery)

    response.send(tweetDetails)
  } catch (e) {
    console.log('Internal Server Error: ' + e)
    response.status(500).send('Internal Server Error')
  }
})

// API -- 7 If the user requests a tweet of a user he is following, return the list of usernames who liked the tweet else send invalid request
app.get(
  '/tweets/:tweetId/likes/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const userId = request.user.user_id
    try {
      // Check if the tweet belongs to a user whom the logged-in user follows
      const checkFollowingQuery = `
      SELECT 1 
      FROM follower 
      INNER JOIN tweet ON follower.following_user_id = tweet.user_id
      WHERE follower.follower_user_id = ${userId} AND tweet.tweet_id = ${tweetId};`

      const isFollowing = await db.get(checkFollowingQuery)

      if (!isFollowing) {
        response.status(401).send('Invalid Request')
        return
      }

      // Fetch the usernames of users who liked the tweet
      const getLikesQuery = `
      SELECT DISTINCT user.username 
      FROM like 
      INNER JOIN user ON like.user_id = user.user_id
      WHERE like.tweet_id = ${tweetId};`

      const likedUsers = await db.all(getLikesQuery)
      const likes = likedUsers.map(user => user.username)

      response.send({likes})
    } catch (error) {
      console.error('Internal Server Error:', error)
      response.status(500).send('Internal Server Error')
    }
  },
)

// API 8: Get tweet replies if the user follows the tweet owner
app.get(
  '/tweets/:tweetId/replies/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const userId = request.user.user_id
    try {
      // Check if tweet exists and get the user who posted it
      const tweetQuery = `
      SELECT user_id FROM tweet WHERE tweet_id = ?;
    `
      const tweet = await db.get(tweetQuery, [tweetId])

      if (!tweet) {
        return response.status(401).send('Invalid Request')
      }

      // Check if logged-in user follows the tweet owner
      const followingQuery = `
      SELECT 1 FROM follower
      WHERE follower.follower_user_id = ? AND follower.following_user_id = ?;
    `
      const isFollowing = await db.get(followingQuery, [userId, tweet.user_id])

      if (!isFollowing) {
        return response.status(401).send('Invalid Request')
      }

      // Fetch replies for the tweet
      const repliesQuery = `
      SELECT user.name, reply.reply 
      FROM reply 
      JOIN user ON reply.user_id = user.user_id
      WHERE reply.tweet_id = ?;
    `
      const replies = await db.all(repliesQuery, [tweetId])

      return response.json({replies})
    } catch (error) {
      console.error(error)
      response.status(500).send('Internal Server Error')
    }
  },
)

//API 9 -- getting all tweets of login user
app.get('/user/tweets/', authenticateToken, async (request, response) => {
  try {
    const userId = request.user.user_id

    // Fetch all tweets by the logged-in user
    const tweetsQuery = `
      SELECT 
        tweet.tweet,
        (SELECT COUNT(*) FROM like WHERE like.tweet_id = tweet.tweet_id) AS likes,
        (SELECT COUNT(*) FROM reply WHERE reply.tweet_id = tweet.tweet_id) AS replies,
        tweet.date_time AS dateTime
      FROM tweet
      WHERE tweet.user_id = ?;
    `

    const tweets = await db.all(tweetsQuery, [userId])

    response.json(tweets)
  } catch (error) {
    console.error(error)
    response.status(500).send('Internal Server Error')
  }
})

//API 10 -- creating a tweet
app.post('/user/tweets/', authenticateToken, async (request, response) => {
  const {tweet} = request.body
  const userId = request.user.user_id
  try {
    const createTweetQuery = `
    INSERT INTO tweet (tweet,user_id)
    VALUES ('${tweet}',${userId});`
    await db.run(createTweetQuery)
    response.send('Created a Tweet')
  } catch (e) {
    console.log('internal server error: ' + e)
  }
})

//API 11 - deleting tweets based on tweetId
app.delete(
  '/tweets/:tweetId/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const userId = request.user.user_id // Extract user ID from authentication middleware

    try {
      // Check if the tweet belongs to the logged-in user
      const getTweetQuery = `SELECT user_id FROM tweet WHERE tweet_id = ?;`
      const tweet = await db.get(getTweetQuery, [tweetId])

      if (!tweet) {
        response.status(404).send('Tweet not found')
        return
      }

      if (tweet.user_id !== userId) {
        response.status(401).send('Invalid Request')
        return
      }

      // Delete the tweet
      const deleteTweetQuery = `DELETE FROM tweet WHERE tweet_id = ?;`
      await db.run(deleteTweetQuery, [tweetId])

      response.send('Tweet Removed')
    } catch (error) {
      console.error('Internal server error:', error)
      response.status(500).send('Internal Server Error')
    }
  },
)

module.exports = app
