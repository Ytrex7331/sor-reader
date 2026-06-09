pipeline {
    // This tells Jenkins to spin up a 
    //ode container to run these steps
    agent {
        docker {
            image 'node:18-alpine' 
            label 'docker-worker' // <-- THIS is the magic link!
            // alpine is a lightweight version of Linux, saving download time
        }
    }

    stages {
        stage('Install Dependencies') {
            steps {
                echo 'Installing NPM dependencies...'
                // 'npm ci' is strictly for CI/CD environments. 
                // It reads your package-lock.json and installs exactly what is there.
                sh 'npm ci' 
            }
        }

        stage('Lint & Test') {
            steps {
                echo 'Running tests...'
                // If you have tests or a linter, run them here. 
                // If they fail, the pipeline stops automatically.
            }
        }

        stage('Build JSX App') {
            steps {
                echo 'Building the production app...'
            }
        }
    }

    post {
        always {
            echo 'Pipeline has finished running.'
            // You can add steps here to send Slack notifications or email alerts later!
        }
    }
}