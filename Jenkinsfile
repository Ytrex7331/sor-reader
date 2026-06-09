pipeline {
    // Run the pipeline on your specialized worker machine
    agent { label 'docker-worker' }

    stages {
        stage('Build JSX App') {
            // Only this specific stage spins up the Node container to compile your code
            agent {
                docker {
                    image 'node:18-alpine'
                    reuseNode true
                }
            }
            steps {
                echo 'Installing dependencies and compiling production files...'
                sh 'npm ci'
                sh 'npm run build' 
                // This creates the 'dist' folder on your worker machine
            }
        }

        stage('Push to Docker Hub') {
            // This stage runs directly on the docker-worker host so it can use Docker commands
            steps {
                script {
                    // This securely logs into Docker Hub using your saved credentials
                    docker.withRegistry('https://index.docker.io/v1/', 'docker-hub-creds') {
                        
                        echo 'Building the production Nginx image...'
                        // 1. Build the image using the Dockerfile we just created
                        def productionImage = docker.build("ytrex/sor-reader:latest")
                        
                        echo 'Pushing image to the Registry library...'
                        // 2. Push it up to your global Docker Hub account
                        productionImage.push()
                    }
                }
            }
        }
    }

    post {
        always {
            echo 'Pipeline execution complete.'
        }
    }
}